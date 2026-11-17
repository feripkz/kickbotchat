import express from 'express';
import { getStore } from '@netlify/blobs';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { sessions, userPreferences, users } from '../../db/schema.ts';

const app = express();
const scrypt = promisify(scryptCallback);
const AUTH_COOKIE = 'kivoz_auth';
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const VOICE_MODEL_LIMIT = 120 * 1024 * 1024;
const VOICE_STORAGE_LIMIT = 500 * 1024 * 1024;
const VOICE_CONFIG_LIMIT = 2 * 1024 * 1024;
const VOICE_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_SETTINGS = {
  channel: '',
  tiktokChannel: '',
  command: '!aa',
  voice: '',
  voiceRules: [],
  rate: 1,
  pitch: 1,
  volume: 0.8,
  readName: true,
  skipLinks: true,
  skipEmotes: true,
  cooldown: 3,
  maxLength: 200,
  blocked: '',
  audience: 'all',
};

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const origin = req.headers.origin;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    if (!origin || origin !== `${protocol}://${req.headers.host}`) {
      return res.status(403).json({ error: 'Origen no permitido.' });
    }
  }
  next();
});

const setupToken = () => process.env.KIVOZ_ADMIN_SETUP_TOKEN;
const setupTokenIsConfigured = () => typeof setupToken() === 'string' && setupToken().length >= 32;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const readAuthToken = req => {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim());
  const value = cookie.find(part => part.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};
const passwordHash = async password => {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
};
const passwordMatches = async (password, storedHash) => {
  const [, salt, expectedHex] = storedHash.split('$');
  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
};
const textMatches = (provided, expected) => {
  const providedBuffer = Buffer.from(provided || '');
  const expectedBuffer = Buffer.from(expected || '');
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};
const setAuthCookie = (res, token) => res.cookie(AUTH_COOKIE, token, {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  maxAge: SESSION_DURATION,
  path: '/',
});
const clearAuthCookie = res => res.clearCookie(AUTH_COOKIE, {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
});
const issueSession = async (user, res) => {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    tokenHash: tokenHash(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_DURATION),
  });
  setAuthCookie(res, token);
};
const requireAuth = async (req, res, next) => {
  const token = readAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    const [row] = await db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      expiresAt: sessions.expiresAt,
    }).from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, tokenHash(token)));
    if (!row || row.expiresAt <= new Date()) {
      if (row) await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Tu sesión ha caducado. Inicia sesión de nuevo.' });
    }
    req.user = { id: row.id, username: row.username, role: row.role };
    next();
  } catch {
    res.status(503).json({ error: 'No se pudo validar la sesión. Inténtalo de nuevo.' });
  }
};
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Esta acción requiere permisos de administrador.' });
  next();
};
const validUsername = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const publicUser = ({ id, username, role }) => ({ id, username, role });
const piperStore = () => getStore({ name: 'kivoz-piper-voices', consistency: 'strong' });
const voicePrefix = id => `voices/${id}`;
const validVoiceId = id => /^[a-f0-9-]{36}$/i.test(id);
const expectedChunkSize = (size, index) => Math.min(VOICE_CHUNK_SIZE, size - index * VOICE_CHUNK_SIZE);
const validPiperConfig = config => config && typeof config === 'object'
  && Number.isInteger(config.audio?.sample_rate) && config.audio.sample_rate > 0
  && config.phoneme_id_map && typeof config.phoneme_id_map === 'object'
  && config.inference && typeof config.inference === 'object'
  && Number.isInteger(config.num_speakers) && config.num_speakers > 0
  && typeof config.language?.code === 'string' && config.language.code.length <= 32;

app.get('/api/auth/status', async (req, res) => {
  try {
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    const token = readAuthToken(req);
    let currentUser = null;
    if (token) {
      const [row] = await db.select({
        id: users.id,
        username: users.username,
        role: users.role,
        expiresAt: sessions.expiresAt,
      }).from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, tokenHash(token)));
      if (row?.expiresAt > new Date()) currentUser = publicUser(row);
      else clearAuthCookie(res);
    }
    res.json({
      user: currentUser,
      setupRequired: !user,
      setupAvailable: !user && setupTokenIsConfigured(),
    });
  } catch {
    res.status(503).json({ error: 'No se pudo comprobar el estado de la cuenta.' });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  const { username, password, setupToken: submittedToken } = req.body || {};
  if (!setupTokenIsConfigured()) return res.status(503).json({ error: 'El alta inicial no está habilitada. Configura KIVOZ_ADMIN_SETUP_TOKEN en el servidor.' });
  if (typeof submittedToken !== 'string' || !textMatches(submittedToken, setupToken())) return res.status(403).json({ error: 'El token de configuración no es válido.' });
  if (!validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: 'Usa un nombre de 3 a 32 caracteres y una contraseña de 12 a 128 caracteres.' });
  }
  try {
    const user = await db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) return null;
      const [created] = await tx.insert(users).values({
        id: randomUUID(),
        username: username.toLowerCase(),
        passwordHash: await passwordHash(password),
        role: 'admin',
      }).returning({ id: users.id, username: users.username, role: users.role });
      return created;
    });
    if (!user) return res.status(409).json({ error: 'La cuenta administradora ya está configurada. Inicia sesión.' });
    await issueSession(user, res);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso.' });
    res.status(503).json({ error: 'No se pudo crear la cuenta administradora.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !validUsername(username.trim()) || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Escribe tu nombre de usuario y contraseña.' });
  }
  try {
    const [user] = await db.select().from(users).where(eq(users.username, username.trim().toLowerCase()));
    const matches = user
      ? await passwordMatches(password, user.passwordHash)
      : await scrypt(password, 'kivoz-auth-dummy-salt', 64).then(() => false);
    if (!user || !matches) return res.status(401).json({ error: 'El nombre de usuario o la contraseña no son válidos.' });
    await issueSession(user, res);
    res.json({ user: publicUser(user) });
  } catch {
    res.status(503).json({ error: 'No se pudo iniciar sesión. Inténtalo de nuevo.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = readAuthToken(req);
  try {
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
    clearAuthCookie(res);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'No se pudo cerrar la sesión. Inténtalo de nuevo.' });
  }
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || currentPassword.length > 128 || !validPassword(newPassword)) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener entre 12 y 128 caracteres.' });
  }
  try {
    const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.user.id));
    if (!user || !await passwordMatches(currentPassword, user.passwordHash)) {
      return res.status(400).json({ error: 'La contraseña actual no es válida.' });
    }
    const newHash = await passwordHash(newPassword);
    const token = randomBytes(32).toString('base64url');
    await db.transaction(async tx => {
      await tx.update(users).set({ passwordHash: newHash }).where(eq(users.id, req.user.id));
      await tx.delete(sessions).where(eq(sessions.userId, req.user.id));
      await tx.insert(sessions).values({
        tokenHash: tokenHash(token),
        userId: req.user.id,
        expiresAt: new Date(Date.now() + SESSION_DURATION),
      });
    });
    setAuthCookie(res, token);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'No se pudo actualizar la contraseña.' });
  }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, req.user.id));
    res.json({ settings: row?.settings || DEFAULT_SETTINGS, theme: row?.theme || 'dark' });
  } catch {
    res.status(503).json({ error: 'No se han podido recuperar los ajustes. Puedes continuar y volver a guardarlos.' });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const s = req.body;
  const validVoiceRule = rule => rule && typeof rule.id === 'string' && rule.id.length <= 36
    && ['username', 'role', 'subscriber', 'donor'].includes(rule.type)
    && ['all', 'kick', 'tiktok'].includes(rule.platform)
    && typeof rule.voice === 'string' && rule.voice.length > 0 && rule.voice.length <= 300
    && (rule.type === 'username'
      ? typeof rule.value === 'string' && /^[a-zA-Z0-9._-]{1,32}$/.test(rule.value)
      : rule.type === 'role'
        ? ['moderator', 'broadcaster'].includes(rule.value)
        : rule.value === '');
  if (!s || typeof s.channel !== 'string' || !/^[a-zA-Z0-9_-]{0,60}$/.test(s.channel) || typeof s.tiktokChannel !== 'string' || !/^[a-zA-Z0-9._]{0,24}$/.test(s.tiktokChannel) || typeof s.command !== 'string' || !/^\S{1,20}$/.test(s.command) || typeof s.voice !== 'string' || s.voice.length > 300 || !Array.isArray(s.voiceRules) || s.voiceRules.length > 30 || !s.voiceRules.every(validVoiceRule) || typeof s.blocked !== 'string' || s.blocked.length > 2000 || !['all', 'subscribers', 'moderators'].includes(s.audience) || !['rate', 'pitch', 'volume', 'cooldown', 'maxLength'].every(k => Number.isFinite(s[k])) || s.rate < 0.5 || s.rate > 2 || s.pitch < 0.5 || s.pitch > 2 || s.volume < 0 || s.volume > 1 || s.cooldown < 0 || s.cooldown > 60 || s.maxLength < 20 || s.maxLength > 500 || !['dark', 'light'].includes(s.theme)) {
    return res.status(400).json({ error: 'Revisa los ajustes e inténtalo de nuevo.' });
  }
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, s[key]]));
  for (const key of ['readName', 'skipLinks', 'skipEmotes']) settings[key] = Boolean(s[key]);
  try {
    await db.insert(userPreferences).values({
      userId: req.user.id,
      settings,
      theme: s.theme,
    }).onConflictDoUpdate({
      target: userPreferences.userId,
      set: { settings, theme: s.theme, updatedAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'No se han podido guardar los ajustes. Inténtalo de nuevo.' });
  }
});

app.get('/api/voices', requireAuth, async (req, res) => {
  try {
    const store = piperStore();
    const { blobs = [] } = await store.list({ prefix: 'voices/' });
    const manifests = blobs.filter(blob => blob.key.endsWith('/manifest.json'));
    const voices = (await Promise.all(manifests.map(blob => store.get(blob.key, { type: 'json' }))))
      .filter(Boolean)
      .map(({ id, name, language, numSpeakers, modelSize, chunks }) => ({
        id, name, language, numSpeakers, modelSize, chunks,
        voiceURI: `piper:${id}`,
        lang: language,
        localService: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    res.json({ voices });
  } catch {
    res.status(503).json({ error: 'No se pudieron cargar las voces compartidas.' });
  }
});

app.get('/api/voices/:id/config', requireAuth, async (req, res) => {
  if (!validVoiceId(req.params.id)) return res.status(400).json({ error: 'La voz indicada no es válida.' });
  try {
    const store = piperStore();
    const manifest = await store.get(`${voicePrefix(req.params.id)}/manifest.json`, { type: 'json' });
    if (!manifest) return res.status(404).json({ error: 'La voz ya no está disponible.' });
    const config = await store.get(`${voicePrefix(req.params.id)}/config.json`, { type: 'json' });
    if (!config) return res.status(404).json({ error: 'No se encontró la configuración de esta voz.' });
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(config);
  } catch {
    res.status(503).json({ error: 'No se pudo cargar la configuración de la voz.' });
  }
});

app.get('/api/voices/:id/model/:chunk', requireAuth, async (req, res) => {
  if (!validVoiceId(req.params.id) || !/^\d{1,6}$/.test(req.params.chunk)) {
    return res.status(400).json({ error: 'El fragmento del modelo no es válido.' });
  }
  try {
    const store = piperStore();
    const manifest = await store.get(`${voicePrefix(req.params.id)}/manifest.json`, { type: 'json' });
    const index = Number(req.params.chunk);
    if (!manifest) return res.status(404).json({ error: 'La voz ya no está disponible.' });
    if (!Number.isInteger(index) || index < 0 || index >= manifest.chunks) {
      return res.status(404).json({ error: 'No se encontró el fragmento del modelo.' });
    }
    const chunk = await store.get(`${voicePrefix(req.params.id)}/model/${String(index).padStart(6, '0')}`, { type: 'arrayBuffer' });
    if (!chunk) return res.status(404).json({ error: 'No se encontró el fragmento del modelo.' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(chunk));
  } catch {
    res.status(503).json({ error: 'No se pudo descargar el modelo de voz.' });
  }
});

app.post('/api/admin/voices', requireAuth, requireAdmin, async (req, res) => {
  const { name, modelSize } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 60
    || !Number.isSafeInteger(modelSize) || modelSize < 1 || modelSize > VOICE_MODEL_LIMIT) {
    return res.status(400).json({ error: 'El nombre o el tamaño del modelo no son válidos. El modelo debe pesar hasta 120 MB.' });
  }
  try {
    const store = piperStore();
    const { blobs = [] } = await store.list({ prefix: 'voices/' });
    const pendingCount = blobs.filter(blob => blob.key.endsWith('/pending.json')).length;
    const records = blobs.filter(blob => blob.key.endsWith('/manifest.json') || blob.key.endsWith('/pending.json'));
    const storedVoices = await Promise.all(records.map(blob => store.get(blob.key, { type: 'json' })));
    const voiceCount = blobs.filter(blob => blob.key.endsWith('/manifest.json')).length;
    if (pendingCount + voiceCount >= 50) return res.status(409).json({ error: 'Se alcanzó el límite de 50 voces. Elimina una voz o carga pendiente antes de continuar.' });
    const storedBytes = storedVoices.reduce((total, voice) => total + (Number.isSafeInteger(voice?.modelSize) ? voice.modelSize : 0), 0);
    if (storedBytes + modelSize > VOICE_STORAGE_LIMIT) return res.status(409).json({ error: 'La biblioteca alcanzaría el límite compartido de 500 MB. Elimina un modelo antes de cargar otro.' });
    const id = randomUUID();
    const chunks = Math.ceil(modelSize / VOICE_CHUNK_SIZE);
    await store.setJSON(`${voicePrefix(id)}/pending.json`, {
      id,
      name: name.trim(),
      modelSize,
      chunks,
    }, { onlyIfNew: true });
    res.status(201).json({ id, chunkSize: VOICE_CHUNK_SIZE, chunks });
  } catch {
    res.status(503).json({ error: 'No se pudo iniciar la carga de la voz.' });
  }
});

app.put('/api/admin/voices/:id/config', requireAuth, requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: VOICE_CONFIG_LIMIT }),
  async (req, res) => {
    if (!validVoiceId(req.params.id) || !Buffer.isBuffer(req.body) || req.body.length < 1) {
      return res.status(400).json({ error: 'El archivo de configuración no es válido.' });
    }
    try {
      const store = piperStore();
      const pending = await store.get(`${voicePrefix(req.params.id)}/pending.json`, { type: 'json' });
      if (!pending) return res.status(404).json({ error: 'No se encontró una carga pendiente para esta voz.' });
      if (req.body.length > VOICE_CONFIG_LIMIT) return res.status(413).json({ error: 'El archivo de configuración no puede superar 2 MB.' });
      const bytes = req.body;
      await store.set(`${voicePrefix(req.params.id)}/config-upload.json`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'No se pudo guardar la configuración de la voz.' });
    }
  });

app.put('/api/admin/voices/:id/model/:chunk', requireAuth, requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: VOICE_CHUNK_SIZE }),
  async (req, res) => {
    if (!validVoiceId(req.params.id) || !/^\d{1,6}$/.test(req.params.chunk) || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'El fragmento del modelo no es válido.' });
    }
    try {
      const store = piperStore();
      const pending = await store.get(`${voicePrefix(req.params.id)}/pending.json`, { type: 'json' });
      const index = Number(req.params.chunk);
      if (!pending) return res.status(404).json({ error: 'No se encontró una carga pendiente para esta voz.' });
      if (!Number.isInteger(index) || index < 0 || index >= pending.chunks
        || req.body.length !== expectedChunkSize(pending.modelSize, index)) {
        return res.status(400).json({ error: 'El tamaño o número del fragmento del modelo no es válido.' });
      }
      const bytes = req.body;
      const key = `${voicePrefix(req.params.id)}/model/${String(index).padStart(6, '0')}`;
      await store.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await store.setJSON(`${voicePrefix(req.params.id)}/uploaded/${String(index).padStart(6, '0')}.json`, { size: bytes.length });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'No se pudo guardar el fragmento del modelo.' });
    }
  });

app.post('/api/admin/voices/:id/complete', requireAuth, requireAdmin, async (req, res) => {
  if (!validVoiceId(req.params.id)) return res.status(400).json({ error: 'La voz indicada no es válida.' });
  try {
    const store = piperStore();
    const prefix = voicePrefix(req.params.id);
    const pending = await store.get(`${prefix}/pending.json`, { type: 'json' });
    if (!pending) return res.status(404).json({ error: 'No se encontró una carga pendiente para esta voz.' });
    const configText = await store.get(`${prefix}/config-upload.json`);
    if (!configText) return res.status(409).json({ error: 'Falta el archivo de configuración `.onnx.json`.' });
    if (Buffer.byteLength(configText, 'utf8') > VOICE_CONFIG_LIMIT) {
      return res.status(413).json({ error: 'El archivo de configuración no puede superar 2 MB.' });
    }
    let config;
    try {
      config = JSON.parse(configText);
    } catch {
      return res.status(400).json({ error: 'El archivo de configuración debe ser un JSON válido.' });
    }
    if (!validPiperConfig(config)) {
      return res.status(400).json({ error: 'La configuración no parece compatible con Piper. Revisa el archivo `.onnx.json`.' });
    }
    for (let index = 0; index < pending.chunks; index++) {
      const suffix = String(index).padStart(6, '0');
      const uploaded = await store.get(`${prefix}/uploaded/${suffix}.json`, { type: 'json' });
      if (uploaded?.size !== expectedChunkSize(pending.modelSize, index)) {
        return res.status(409).json({ error: `Falta el fragmento ${index + 1} de ${pending.chunks} del modelo.` });
      }
    }
    await store.set(`${prefix}/config.json`, configText);
    await store.setJSON(`${prefix}/manifest.json`, {
      id: pending.id,
      name: pending.name,
      language: config.language.code,
      numSpeakers: config.num_speakers,
      sampleRate: config.audio.sample_rate,
      modelSize: pending.modelSize,
      chunks: pending.chunks,
    });
    await store.delete(`${prefix}/pending.json`);
    await store.delete(`${prefix}/config-upload.json`);
    for (let index = 0; index < pending.chunks; index++) {
      await store.delete(`${prefix}/uploaded/${String(index).padStart(6, '0')}.json`);
    }
    res.status(201).json({ voice: {
      id: pending.id,
      name: pending.name,
      language: config.language.code,
      numSpeakers: config.num_speakers,
      sampleRate: config.audio.sample_rate,
      modelSize: pending.modelSize,
      chunks: pending.chunks,
      voiceURI: `piper:${pending.id}`,
      lang: config.language.code,
      localService: true,
    } });
  } catch {
    res.status(503).json({ error: 'No se pudo finalizar la carga de la voz.' });
  }
});

app.delete('/api/admin/voices/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!validVoiceId(req.params.id)) return res.status(400).json({ error: 'La voz indicada no es válida.' });
  try {
    const store = piperStore();
    const prefix = `${voicePrefix(req.params.id)}/`;
    const { blobs = [] } = await store.list({ prefix });
    if (!blobs.length) return res.status(404).json({ error: 'No se encontró esa voz o carga pendiente.' });
    await Promise.all(blobs.map(blob => store.delete(blob.key)));
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'No se pudo eliminar la voz.' });
  }
});

app.post('/api/tiktok/connect-token', requireAuth, requireAdmin, async (req, res) => {
  const secret = process.env.KIVOZ_TIKTOK_SERVICE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    return res.status(503).json({ error: 'El servicio TikTok no está configurado. Revisa KIVOZ_TIKTOK_SERVICE_SECRET en el servidor.' });
  }
  const claims = {
    sub: req.user.id,
    exp: Date.now() + 60_000,
    nonce: randomBytes(18).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  res.json({ token: `${encoded}.${signature}` });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      createdAt: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt));
    res.json({ users: rows });
  } catch {
    res.status(503).json({ error: 'No se pudo cargar la lista de usuarios.' });
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: 'Usa un nombre de 3 a 32 caracteres y una contraseña de 12 a 128 caracteres.' });
  }
  try {
    const [user] = await db.insert(users).values({
      id: randomUUID(),
      username: username.toLowerCase(),
      passwordHash: await passwordHash(password),
      role: 'user',
    }).returning({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt });
    res.status(201).json({ user });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso.' });
    res.status(503).json({ error: 'No se pudo crear el usuario.' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'El usuario indicado no es válido.' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta administradora.' });
  try {
    const [deleted] = await db.delete(users).where(and(eq(users.id, req.params.id), eq(users.role, 'user'))).returning({ id: users.id });
    if (!deleted) return res.status(404).json({ error: 'No se encontró ese usuario.' });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'No se pudo eliminar el usuario.' });
  }
});

app.get('/api/channel/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(slug)) return res.status(400).json({ error: 'Introduce un nombre de canal de Kick válido.' });
  try {
    const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Kivoz/1.0)' }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: response.status === 404 ? 'No encontramos ese canal en Kick. Comprueba el nombre.' : 'Kick no permite conectar en este momento. Vuelve a intentarlo más tarde.' });
    const data = await response.json();
    if (!Number.isSafeInteger(data.chatroom?.id)) return res.status(502).json({ error: 'Este canal no tiene un chat disponible.' });
    if (!Number.isSafeInteger(data.id) || data.id <= 0) return res.status(502).json({ error: 'Kick no devolvió un identificador de canal válido.' });
    const connection = await fetch(`https://web.kick.com/api/v1/realtime/channels/${data.id}/chat/connection`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-app-platform': 'web', Origin: 'https://kick.com', Referer: 'https://kick.com/', 'User-Agent': 'Mozilla/5.0 (compatible; Kivoz/1.0)' },
      body: JSON.stringify({ client: { id: randomUUID(), type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }] } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!connection.ok) return res.status(502).json({ error: 'El canal existe, pero Kick no permite obtener la conexión del chat público en este momento. Vuelve a intentarlo más tarde.' });
    const negotiated = await connection.json();
    const transport = negotiated.data?.mode === 'websocket' && negotiated.data.connections?.find(c => c.provider === 'pusher');
    const publicConfig = transport?.credentials;
    if (!publicConfig || typeof publicConfig.app_key !== 'string' || !/^[a-zA-Z0-9]{1,100}$/.test(publicConfig.app_key) || typeof publicConfig.cluster !== 'string' || !/^[a-z]{2}[0-9]?$/.test(publicConfig.cluster)) {
      return res.status(502).json({ error: 'Kick no ofrece una conexión pública compatible para este chat. Inténtalo de nuevo más tarde.' });
    }
    res.json({ slug: data.slug || slug, chatroomId: data.chatroom.id, transport: { appKey: publicConfig.app_key, cluster: publicConfig.cluster } });
  } catch {
    res.status(502).json({ error: 'No se pudo contactar con Kick. Revisa tu conexión e inténtalo de nuevo.' });
  }
});

app.use((err, req, res, next) => res.status(400).json({ error: 'La solicitud no es válida.' }));
export default app;
