import express from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { preferences } from '../../db/schema.ts';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`) {
    return res.status(403).json({ error: 'Origen no permitido.' });
  }
  const found = (req.headers.cookie || '').match(/(?:^|;\s*)kivoz_session=([a-f0-9-]{36})(?:;|$)/);
  req.sessionId = found?.[1] || randomUUID();
  if (!found) res.cookie('kivoz_session', req.sessionId, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 31536000000, path: '/' });
  next();
});
app.get('/api/settings', async (req, res) => {
  try {
    const [row] = await db.select().from(preferences).where(eq(preferences.id, req.sessionId));
    res.json({ settings: row?.settings || null });
  } catch { res.status(503).json({ error: 'No se han podido recuperar los ajustes. Puedes continuar y volver a guardarlos.' }); }
});
app.put('/api/settings', async (req, res) => {
  const s = req.body;
  if (!s || typeof s.channel !== 'string' || !/^[a-zA-Z0-9_-]{0,60}$/.test(s.channel) || typeof s.command !== 'string' || !/^\S{1,20}$/.test(s.command) || typeof s.voice !== 'string' || s.voice.length > 300 || typeof s.blocked !== 'string' || s.blocked.length > 2000 || !['all', 'subscribers', 'moderators'].includes(s.audience) || !['rate','pitch','volume','cooldown','maxLength'].every(k => Number.isFinite(s[k])) || s.rate < .5 || s.rate > 2 || s.pitch < .5 || s.pitch > 2 || s.volume < 0 || s.volume > 1 || s.cooldown < 0 || s.cooldown > 60 || s.maxLength < 20 || s.maxLength > 500) return res.status(400).json({ error: 'Revisa los ajustes: el comando debe tener entre 1 y 20 caracteres sin espacios.' });
  const settings = Object.fromEntries(['channel','command','voice','rate','pitch','volume','cooldown','maxLength','audience','blocked'].map(k => [k, s[k]]));
  for (const k of ['readName', 'skipLinks', 'skipEmotes']) settings[k] = Boolean(s[k]);
  try {
    await db.insert(preferences).values({ id: req.sessionId, settings }).onConflictDoUpdate({ target: preferences.id, set: { settings, updatedAt: new Date() } });
    res.json({ ok: true });
  } catch { res.status(503).json({ error: 'No se han podido guardar los ajustes. Inténtalo de nuevo.' }); }
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
    // Kick's web client negotiates realtime on web.kick.com, not its legacy API host.
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
    // Only these public connection identifiers are returned, never auth tokens.
    res.json({ slug: data.slug || slug, chatroomId: data.chatroom.id, transport: { appKey: publicConfig.app_key, cluster: publicConfig.cluster } });
  } catch { res.status(502).json({ error: 'No se pudo contactar con Kick. Revisa tu conexión e inténtalo de nuevo.' }); }
});
app.use((err, req, res, next) => res.status(400).json({ error: 'La solicitud no es válida.' }));
export default app;
