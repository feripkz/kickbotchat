import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Pusher from 'pusher-js';
import { AudioLines, LayoutDashboard, Mic2, SlidersHorizontal, ListFilter, Radio, ArrowUpRight, ArrowRight, ChevronDown, ChevronRight, Check, CircleHelp, Play, Pause, SkipForward, Trash2, X, MessageSquare, Link2, ShieldCheck, Save, Settings2, Headphones, CheckCheck, LoaderCircle } from 'lucide-react';
import './styles.css';

const defaults = { channel: '', command: '!aa', voice: '', rate: 1, pitch: 1, volume: .8, readName: true, skipLinks: true, skipEmotes: true, cooldown: 3, maxLength: 200, blocked: '', audience: 'all' };
const nav = [{ name: 'Panel general', icon: LayoutDashboard }, { name: 'Voces', icon: Mic2 }, { name: 'Reglas de lectura', icon: ListFilter }, { name: 'Actividad', icon: AudioLines }];
const time = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const Range = ({ settings, patch, label, prop, min, max, step, unit = '×', display }) => <div className="range-field"><div><label htmlFor={prop}>{label}</label><span>{display || `${Number(settings[prop]).toFixed(1)}${unit}`}</span></div><input id={prop} type="range" min={min} max={max} step={step} value={settings[prop]} style={{ '--fill': `${(settings[prop] - min) / (max - min) * 100}%` }} onChange={e => patch(prop, +e.target.value)}/></div>;
const Toggle = ({ settings, patch, label, detail, prop }) => <label className="toggle-row"><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><input type="checkbox" checked={settings[prop]} onChange={e => patch(prop, e.target.checked)}/><i aria-hidden="true"/></label>;
const VoiceCard = ({ selectedVoice, patch, voice, index }) => <button className={`voice-choice ${selectedVoice?.voiceURI === voice.voiceURI ? 'selected' : ''}`} aria-pressed={selectedVoice?.voiceURI === voice.voiceURI} onClick={() => patch('voice', voice.voiceURI)}><div className={`voice-avatar avatar-${index % 3}`}><AudioLines size={23}/></div><strong>{voice.name.replace(/Microsoft |Google /g, '').split(' - ')[0]}</strong><small>{voice.lang} · {voice.localService ? 'Local' : 'Navegador'}</small><span className="voice-radio">{selectedVoice?.voiceURI === voice.voiceURI && <span/>}</span></button>;
function App() {
  const [page, setPage] = useState('Panel general');
  const [settings, setSettings] = useState(defaults);
  const currentSettings = useRef(settings); currentSettings.current = settings;
  const [voices, setVoices] = useState([]);
  const [status, setStatus] = useState('offline');
  const [connectedChannel, setConnectedChannel] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [voiceModal, setVoiceModal] = useState(false);
  const [help, setHelp] = useState(false);
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState([]);
  const queueRef = useRef([]);
  const [speaking, setSpeaking] = useState(null);
  const speakingRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [history, setHistory] = useState([]);
  const [readCount, setReadCount] = useState(0);
  const [filtered, setFiltered] = useState(0);
  const [testText, setTestText] = useState('¡Hola, chat! ¿Todo listo para el directo?');
  const socket = useRef(null);
  const attempt = useRef(0);
  const connectionTimer = useRef(null);
  const channelRequest = useRef(null);
  const lastMessage = useRef(new Map());
  const seen = useRef(new Set());
  const voiceRef = useRef([]); voiceRef.current = voices;
  const utteranceRef = useRef(null);
  const changed = useRef(false);
  const patch = (key, value) => { changed.current = true; setSettings(s => ({ ...s, [key]: value })); setDirty(true); };
  const notice = text => setToast(text);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!voiceModal && !help) return;
    const previous = document.activeElement;
    const onKey = event => {
      if (event.key === 'Escape') { setVoiceModal(false); setHelp(false); }
      if (event.key !== 'Tab') return;
      const elements = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] input')].filter(el => !el.disabled);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [voiceModal, help]);
  useEffect(() => {
    fetch('/api/settings').then(async r => { const data = await r.json(); if (!r.ok) throw Error(data.error); if (data.settings && !changed.current) setSettings({ ...defaults, ...data.settings }); }).catch(e => setError(e.message || 'No se pudieron cargar los ajustes.')).finally(() => setLoaded(true));
    if ('speechSynthesis' in window) {
      const load = () => setVoices(window.speechSynthesis.getVoices()); load();
      window.speechSynthesis.addEventListener('voiceschanged', load);
      return () => { window.speechSynthesis.removeEventListener('voiceschanged', load); window.speechSynthesis.cancel(); socket.current?.disconnect(); clearTimeout(connectionTimer.current); channelRequest.current?.abort(); attempt.current++; };
    }
  }, []);
  const updateQueue = () => setQueue([...queueRef.current]);
  const pump = () => {
    if (speakingRef.current || pausedRef.current || !queueRef.current.length) return;
    if (!('speechSynthesis' in window)) { setError('Este navegador no admite síntesis de voz. Prueba con Chrome o Edge.'); return; }
    const item = queueRef.current.shift(); updateQueue();
    speakingRef.current = item; setSpeaking(item);
    const s = currentSettings.current;
    const utterance = new SpeechSynthesisUtterance((s.readName && !item.test ? `${item.user} dice: ` : '') + item.text);
    utterance.voice = voiceRef.current.find(v => v.voiceURI === s.voice) || voiceRef.current.find(v => v.lang.startsWith('es')) || null;
    utterance.lang = utterance.voice?.lang || 'es-ES';
    utterance.rate = s.rate; utterance.pitch = s.pitch; utterance.volume = s.volume;
    utteranceRef.current = utterance;
    const finish = success => {
      if (utteranceRef.current !== utterance) return;
      speakingRef.current = null; setSpeaking(null); utteranceRef.current = null;
      if (success && !item.test) setReadCount(n => n + 1);
      setHistory(h => h.map(m => m.id === item.id ? { ...m, state: success ? 'Leído' : 'Error de audio' } : m));
      if (!success) notice('No se pudo reproducir el audio. Comprueba la voz y los permisos de sonido.');
      pump();
    };
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    window.speechSynthesis.speak(utterance);
  };
  const enqueue = item => {
    if (queueRef.current.length >= 50) return false;
    queueRef.current.push(item); updateQueue(); pump(); return true;
  };
  const receive = payload => {
    const s = currentSettings.current;
    if (typeof payload?.content !== 'string') return;
    const id = String(payload.id || crypto.randomUUID());
    if (seen.current.has(id)) return;
    seen.current.add(id); if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value);
    const content = payload.content;
    const user = payload.sender?.username || 'Espectador';
    const matched = Boolean(s.command) && content.startsWith(s.command) && (content.length === s.command.length || /\s/.test(content[s.command.length]));
    let text = matched ? content.slice(s.command.length).trim() : '';
    const badges = payload.sender?.identity?.badges || [];
    const moderator = badges.some(b => ['moderator', 'broadcaster'].includes(b.type));
    const allowed = s.audience === 'all' || moderator || (s.audience === 'subscribers' && badges.some(b => b.type === 'subscriber'));
    const blocked = s.blocked.split(',').map(w => w.trim().toLocaleLowerCase()).filter(Boolean);
    let reason = !matched ? 'Sin comando' : !text ? 'Mensaje vacío' : !allowed ? 'Rol no permitido' : text.length > s.maxLength ? 'Demasiado largo' : s.skipLinks && /https?:\/\/|www\./i.test(text) ? 'Enlace filtrado' : blocked.some(w => text.toLocaleLowerCase().includes(w)) ? 'Palabra bloqueada' : '';
    if (s.skipEmotes) text = text.replace(/\[emote:[^\]]+\]/g, '').trim();
    if (!text && !reason) reason = 'Solo emotes';
    if (!reason && Date.now() - (lastMessage.current.get(user) || 0) < s.cooldown * 1000) reason = 'Tiempo de espera';
    const item = { id, user, text, content, time: time(), state: reason || 'En cola' };
    setHistory(h => [item, ...h].slice(0, 150));
    if (reason) { setFiltered(n => n + 1); return; }
    if (!enqueue(item)) { setFiltered(n => n + 1); setHistory(h => h.map(m => m.id === id ? { ...m, state: 'Cola llena' } : m)); return; }
    lastMessage.current.set(user, Date.now());
    if (lastMessage.current.size > 2000) lastMessage.current.delete(lastMessage.current.keys().next().value);
  };
  const connect = async () => {
    if (status !== 'offline') { attempt.current++; clearTimeout(connectionTimer.current); channelRequest.current?.abort(); socket.current?.disconnect(); socket.current = null; setStatus('offline'); return; }
    setError('');
    let slug = settings.channel.trim();
    if (/^(https?:\/\/)?(www\.)?kick\.com\//i.test(slug)) slug = slug.replace(/^(https?:\/\/)?(www\.)?kick\.com\//i, '').split(/[/?#]/)[0];
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(slug)) { setError('Escribe el nombre de tu canal o su enlace de Kick.'); return; }
    if (!('speechSynthesis' in window)) { setError('Usa un navegador compatible con síntesis de voz, como Chrome o Edge.'); return; }
    patch('channel', slug); setStatus('connecting');
    // Prime browser audio from the connect gesture; subsequent chat messages use the same session.
    const unlock = new SpeechSynthesisUtterance(''); window.speechSynthesis.speak(unlock);
    const request = ++attempt.current;
    try {
      channelRequest.current = new AbortController();
      const res = await fetch(`/api/channel/${encodeURIComponent(slug)}`, { signal: AbortSignal.any([channelRequest.current.signal, AbortSignal.timeout(18000)]) });
      const data = await res.json().catch(() => { throw Error('El servidor no pudo consultar el canal. Inténtalo de nuevo.'); });
      if (request !== attempt.current) return;
      if (!res.ok) throw Error(data.error);
      // Public Kick chat transport identifier; no account credentials are used.
      if (!data.transport?.appKey || !data.transport?.cluster) throw Error('La configuración del chat no está disponible. Recarga la página e inténtalo de nuevo.');
      const client = new Pusher(data.transport.appKey, { cluster: data.transport.cluster, forceTLS: true });
      const fail = message => {
        if (request !== attempt.current) return;
        attempt.current++;
        clearTimeout(connectionTimer.current);
        socket.current = null;
        client.disconnect();
        setConnectedChannel(''); setStatus('offline'); setError(message);
      };
      const waitForSubscription = () => {
        clearTimeout(connectionTimer.current);
        connectionTimer.current = setTimeout(() => fail('El chat de Kick no confirmó la conexión. Comprueba tu red o los bloqueadores del navegador y vuelve a conectar.'), 20000);
      };
      waitForSubscription();
      client.connection.bind('error', event => {
        const code = event?.data?.code;
        if (code >= 4000 && code < 4100) fail('Kick rechazó la conexión del chat. Vuelve a conectar para actualizar sus parámetros.');
      });
      socket.current = client;
      const channel = client.subscribe(`chatrooms.${data.chatroomId}.v2`);
      channel.bind('App\\Events\\ChatMessageEvent', payload => { if (request === attempt.current) receive(payload); });
      channel.bind('pusher:subscription_succeeded', () => { if (request === attempt.current) { clearTimeout(connectionTimer.current); connectionTimer.current = null; setError(''); setStatus('online'); setConnectedChannel(data.slug); notice(`Conectado al chat de ${data.slug}`); } });
      channel.bind('pusher:subscription_error', () => fail('No se pudo suscribir al chat de Kick. Inténtalo de nuevo.'));
      client.connection.bind('state_change', ({ current }) => {
        if (request !== attempt.current || current === 'connected') return;
        if (['connecting', 'unavailable', 'disconnected'].includes(current)) {
          setStatus('connecting');
          if (!connectionTimer.current) waitForSubscription();
        }
        if (current === 'failed') fail('La conexión con el chat falló. Vuelve a conectar.');
      });
    } catch (e) { if (request === attempt.current) { setStatus('offline'); setError(e.message || 'No se pudo conectar con Kick.'); } }
  };
  const save = async () => {
    setSaving(true); setError('');
    try { const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }); const data = await r.json(); if (!r.ok) throw Error(data.error); if (currentSettings.current === settings) setDirty(false); notice('Tu configuración se ha guardado.'); } catch (e) { setError(e.message || 'No se pudieron guardar los ajustes.'); } finally { setSaving(false); }
  };
  const skip = () => {
    const old = speakingRef.current;
    utteranceRef.current = null; window.speechSynthesis?.cancel(); speakingRef.current = null; setSpeaking(null);
    if (old) setHistory(h => h.map(m => m.id === old.id ? { ...m, state: 'Omitido' } : m));
    pump();
  };
  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); if (pausedRef.current) window.speechSynthesis?.pause(); else { window.speechSynthesis?.resume(); pump(); } };
  const clear = () => { queueRef.current = []; updateQueue(); setHistory(h => h.map(m => m.state === 'En cola' && m.id !== speakingRef.current?.id ? { ...m, state: 'Eliminado' } : m)); notice('Cola de lectura vaciada.'); };
  const preview = () => { if (!('speechSynthesis' in window)) return setError('Este navegador no admite síntesis de voz. Prueba con Chrome o Edge.'); if (!testText.trim()) return notice('Escribe un mensaje para probar la voz.'); if (pausedRef.current) togglePause(); if (!enqueue({ id: crypto.randomUUID(), user: 'Prueba de voz', text: testText.trim(), test: true, time: time() })) notice('La cola está llena. Libera un espacio para probar la voz.'); };
  const selectedVoice = voices.find(v => v.voiceURI === settings.voice) || voices.find(v => v.lang.startsWith('es'));
  const voiceName = selectedVoice?.name.replace(/Microsoft |Google /g, '') || 'Voz del dispositivo';
  const spanish = voices.filter(v => v.lang.startsWith('es'));
  const featured = [selectedVoice, ...spanish, ...voices].filter((v, i, a) => v && a.findIndex(x => x?.voiceURI === v.voiceURI) === i).slice(0, 3);
  const Rules = () => <><div className="rule-grid"><div className="field"><label htmlFor="audience">Quién puede usar el comando</label><select id="audience" value={settings.audience} onChange={e => patch('audience', e.target.value)}><option value="all">Todos los espectadores</option><option value="subscribers">Suscriptores y moderadores</option><option value="moderators">Solo moderadores y broadcaster</option></select></div><div className="field"><label htmlFor="cooldown">Espera por usuario</label><div className="unit-input"><input id="cooldown" type="number" min="0" max="60" value={settings.cooldown} onChange={e => patch('cooldown', +e.target.value)}/><span>segundos</span></div></div><div className="field"><label htmlFor="maxLength">Longitud máxima</label><div className="unit-input"><input id="maxLength" type="number" min="20" max="500" value={settings.maxLength} onChange={e => patch('maxLength', +e.target.value)}/><span>caracteres</span></div></div><div className="field"><label htmlFor="blocked">Palabras bloqueadas</label><input id="blocked" placeholder="Separa las palabras con comas" value={settings.blocked} onChange={e => patch('blocked', e.target.value)}/></div></div><Toggle settings={settings} patch={patch} label="Omitir mensajes con enlaces" detail="Evita que se lean URLs durante el directo." prop="skipLinks"/><Toggle settings={settings} patch={patch} label="Omitir emotes de Kick" detail="Lee solo el texto, sin los códigos de los emotes." prop="skipEmotes"/></>;
  const Activity = () => <div className="activity-list">{history.length ? history.map(m => <div className="activity-row" key={m.id}><div className="user-avatar">{m.user.slice(0,2).toUpperCase()}</div><div><strong>{m.user} <time>{m.time}</time></strong><p>{m.content}</p></div><span className={`message-state ${m.state === 'Leído' ? 'success' : ''}`}>{m.state}</span></div>) : <div className="empty"><MessageSquare size={28}/><strong>La conversación empieza aquí</strong><p>Conecta tu canal para ver los mensajes recibidos<br/>y saber cuáles pasan tus reglas de lectura.</p></div>}</div>;

  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/" aria-label="Kivoz, inicio"><span className="brand-mark">k<span/></span>kivoz<span className="brand-dot">.</span></a><div className="workspace"><div className="workspace-icon"><Radio size={19}/></div><div><strong>Mi estudio</strong><span>Tu espacio de streaming</span></div><ChevronDown size={14}/></div><span className="nav-label">TU ESTUDIO</span><nav>{nav.map(({ name, icon: Icon }) => <button key={name} aria-label={name} title={name} aria-current={page === name ? 'page' : undefined} className={page === name ? 'active' : ''} onClick={() => setPage(name)}><Icon size={19}/>{name}{name === 'Panel general' && <span className="nav-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="tip-card"><span className="tip-icon"><Headphones size={20}/></span><strong>Tu comunidad, en voz alta.</strong><p>Tú haces el directo.<br/>Nosotros ponemos la voz.</p><button onClick={() => setHelp(true)}>Cómo funciona <ArrowUpRight size={15}/></button></div><button aria-label="Configuración" title="Configuración" className={page === 'Configuración' ? 'side-action active' : 'side-action'} onClick={() => setPage('Configuración')}><Settings2 size={18}/>Configuración</button><button aria-label="Ayuda y primeros pasos" title="Ayuda y primeros pasos" className="side-action" onClick={() => setHelp(true)}><CircleHelp size={18}/>Ayuda y primeros pasos<ArrowUpRight size={14}/></button><div className="sidebar-footer"><span className="tiny-brand">K</span><span>Hecho para tu próximo directo</span></div></div></aside>
  <div className="main-wrap"><header className="topbar"><div><span className="breadcrumb-home">Mi estudio</span><ChevronRight size={13}/><span>{page}</span></div><div className="topbar-right"><span className="version">ESTUDIO v1.0</span><span className={`connection-badge ${status === 'online' ? 'online' : ''}`}><i/>{status === 'online' ? 'Canal conectado' : status === 'connecting' ? 'Conectando…' : 'Sin conexión'}</span><button className="profile" onClick={() => setPage('Configuración')} aria-label="Configuración del estudio">ME</button></div></header>
  <main><section className="page-heading"><div><div className="eyebrow"><span/> TU ASISTENTE DE DIRECTO</div><h1>{page === 'Panel general' ? <>Tu chat tiene <span>voz.</span></> : page === 'Voces' ? <>Una voz muy <span>tuya.</span></> : page === 'Reglas de lectura' ? <>Tú pones las <span>reglas.</span></> : page === 'Actividad' ? <>El pulso de tu <span>chat.</span></> : <>Todo a tu <span>manera.</span></>}</h1><p>{page === 'Panel general' ? 'Conecta tu canal, elige una voz y deja que tu comunidad se escuche.' : page === 'Voces' ? 'Encuentra el sonido de tu comunidad con las voces de tu dispositivo.' : page === 'Reglas de lectura' ? 'Decide qué se lee y mantén el control de tu directo.' : page === 'Actividad' ? 'Todos los mensajes y sus estados, durante esta sesión.' : 'Personaliza la conexión y guarda tus preferencias para el próximo directo.'}</p></div><button aria-label="Guardar cambios" title="Guardar cambios" className="button secondary save-button" disabled={saving || !loaded} onClick={save}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>} {saving ? 'Guardando…' : 'Guardar cambios'}{dirty && <i className="unsaved-dot"/>}</button></section>
  {error && <div className="error" role="alert"><CircleHelp size={17}/><span>{error}</span><button aria-label="Cerrar aviso" onClick={() => setError('')}><X size={16}/></button></div>}
  {(page === 'Panel general' || page === 'Configuración') && <div className="connection-strip"><div className="kick-logo">K</div><div className="connection-copy"><strong>Tu canal de Kick</strong><span>{status === 'online' ? `Escuchando a la comunidad de ${connectedChannel}` : 'El punto de encuentro con tu comunidad'}</span></div><div className="channel-input"><span>kick.com/</span><input aria-label="Nombre de canal de Kick" placeholder="tu_canal" value={settings.channel} disabled={status !== 'offline' || !loaded} onChange={e => patch('channel', e.target.value.trim().replace(/^(https?:\/\/)?(www\.)?kick\.com\//i, '').split(/[/?#]/)[0])} onKeyDown={e => e.key === 'Enter' && connect()}/></div><button onClick={connect} disabled={!loaded} className={`button ${status === 'online' ? 'secondary' : 'primary'}`}>{status === 'connecting' ? <LoaderCircle size={16} className="spin"/> : <Link2 size={16}/>} {status === 'online' ? 'Desconectar' : status === 'connecting' ? 'Cancelar' : 'Conectar canal'}{status === 'offline' && <ArrowUpRight size={16}/>}</button></div>}
  {page === 'Panel general' && <><div className="studio-grid"><section className="card voice-panel"><div className="card-heading"><div className="section-title"><span className="section-icon"><Mic2 size={18}/></span><h2>La voz de tu chat</h2></div><span className="tag">VOCES GRATIS</span></div><div className="subhead"><p>Elige quién le da vida a tus mensajes.</p><button className="text-button" onClick={() => setVoiceModal(true)}>Explorar voces <ArrowUpRight size={14}/></button></div><div className="voice-options">{featured.length ? featured.map((v,i) => <VoiceCard selectedVoice={selectedVoice} patch={patch} key={v.voiceURI} voice={v} index={i}/>) : <div className="voice-fallback"><AudioLines size={28}/><div><strong>Voz predeterminada en español</strong><p>El navegador carga las voces disponibles en tu dispositivo.</p></div><button className="icon-button" title="Actualizar voces" onClick={() => setVoices(window.speechSynthesis?.getVoices() || [])}><Radio size={17}/></button></div>}</div><div className="sliders"><Range settings={settings} patch={patch} label="Velocidad" prop="rate" min={.5} max={2} step={.1}/><Range settings={settings} patch={patch} label="Tono" prop="pitch" min={.5} max={2} step={.1}/><Range settings={settings} patch={patch} label="Volumen" prop="volume" min={0} max={1} step={.05} display={`${Math.round(settings.volume * 100)}%`}/></div><div className="voice-test"><input aria-label="Texto de prueba de voz" maxLength={300} value={testText} onChange={e => setTestText(e.target.value)} onKeyDown={e => e.key === 'Enter' && preview()}/><button onClick={preview}><Play size={14} fill="currentColor"/> Probar voz</button></div><div className="card-footnote"><Headphones size={13}/><span>La voz se reproduce en este navegador. Mantenlo abierto durante el directo.</span></div></section>
  <section className="card command-panel"><div className="card-heading"><div className="section-title"><span className="section-icon"><SlidersHorizontal size={18}/></span><h2>A tu manera</h2></div><span className="step-label">01 / AJUSTES</span></div><div className="field command-field"><label htmlFor="command">Comando de activación <span>PERSONALIZABLE</span></label><div className="command-input"><span>⌘</span><input id="command" value={settings.command} maxLength={20} onChange={e => patch('command', e.target.value.replace(/\s/g, ''))}/><span className="key-label">COMANDO</span></div><small>Solo se leen los mensajes que empiecen con este comando.</small></div><div className="chat-example"><span className="example-label">ASÍ LO USA TU CHAT</span><div><span className="example-user">tu_comunidad</span><p><b>{settings.command || '!aa'}</b> ¡Hola, streamer!</p></div></div><Toggle settings={settings} patch={patch} label="Leer nombre de usuario" detail="Antes de cada mensaje" prop="readName"/><button className="rules-link" onClick={() => setPage('Reglas de lectura')}><ShieldCheck size={16}/>Filtros y reglas de lectura<ArrowRight size={16}/></button></section></div>
  <div className="session-summary"><span><span className="session-dot"/> ESTA SESIÓN</span><div><MessageSquare size={15}/><strong>{readCount}</strong> mensajes leídos</div><div><ListFilter size={15}/><strong>{filtered}</strong> filtrados</div><div><AudioLines size={15}/><strong>{queue.length}</strong> en cola</div><span className="summary-note">Tu directo, bajo control.</span></div>
  <section className="card queue-panel"><div className="card-heading"><div className="section-title"><span className="section-icon"><AudioLines size={18}/></span><h2>Cola de lectura</h2><span className="count-badge">{queue.length}</span></div><div className="queue-actions"><button aria-label={paused ? 'Reanudar lectura' : 'Pausar lectura'} onClick={togglePause} className={paused ? 'is-paused' : ''}>{paused ? <Play size={14}/> : <Pause size={14}/>}<span>{paused ? 'Reanudar' : 'Pausar'}</span></button><button aria-label="Vaciar cola" onClick={clear} disabled={!queue.length}><Trash2 size={14}/><span>Vaciar cola</span></button></div></div><div className={`now-playing ${speaking && !paused ? 'playing' : ''}`}><div className="waveform">{Array.from({ length: 21 },(_,i) => <i key={i} style={{ '--h': `${8 + ((i * 13 + 11) % 30)}px`, '--delay': `${i * .06}s` }}/>)}</div><div className="playing-copy"><span>{speaking ? paused ? 'LECTURA EN PAUSA' : 'LEYENDO AHORA' : 'TODO LISTO PARA ESCUCHAR'}</span><strong>{speaking ? speaking.text : 'El próximo mensaje tiene la palabra.'}</strong><small>{speaking ? speaking.user : `Los mensajes con ${settings.command || '!aa'} aparecen aquí al conectar tu canal.`}</small></div><button className="skip-button" disabled={!speaking} aria-label="Saltar mensaje actual" onClick={skip}><SkipForward size={19}/></button></div>{queue.length > 0 && <div className="queued-messages">{queue.slice(0,5).map((m,i) => <div key={m.id}><span>{String(i + 1).padStart(2,'0')}</span><strong>{m.user}</strong><p>{m.text}</p><button aria-label={`Eliminar mensaje de ${m.user}`} onClick={() => { queueRef.current = queueRef.current.filter(x => x.id !== m.id); updateQueue(); setHistory(h => h.map(x => x.id === m.id ? { ...x, state: 'Eliminado' } : x)); }}><X size={15}/></button></div>)}{queue.length > 5 && <small>Y {queue.length - 5} mensajes más…</small>}</div>}<div className="queue-bottom"><span><ShieldCheck size={13}/> Filtrado antes de llegar a tus oídos</span><button onClick={() => setPage('Actividad')}>Ver actividad <ArrowRight size={13}/></button></div></section></>}
  {page === 'Voces' && <section className="card standalone"><div className="card-heading"><div className="section-title"><Mic2 size={19}/><h2>Biblioteca de voces</h2></div><span className="tag">{voices.length} DISPONIBLES</span></div><p className="muted">Las voces varían según tu navegador y sistema operativo. Algunas requieren conexión a Internet.</p><input className="search" placeholder="Buscar por nombre o idioma…" aria-label="Buscar voces" value={search} onChange={e => setSearch(e.target.value)}/><div className="voice-library">{voices.filter(v => `${v.name} ${v.lang}`.toLowerCase().includes(search.toLowerCase())).map((v,i) => <VoiceCard selectedVoice={selectedVoice} patch={patch} key={v.voiceURI} voice={v} index={i}/>)}</div>{!voices.length && <p className="muted">No se han detectado voces. Instala voces en los ajustes de idioma de tu dispositivo o prueba Chrome o Edge.</p>}<div className="sliders"><Range settings={settings} patch={patch} label="Velocidad" prop="rate" min={.5} max={2} step={.1}/><Range settings={settings} patch={patch} label="Tono" prop="pitch" min={.5} max={2} step={.1}/><Range settings={settings} patch={patch} label="Volumen" prop="volume" min={0} max={1} step={.05} display={`${Math.round(settings.volume * 100)}%`}/></div><div className="voice-test"><input aria-label="Texto para probar voz" value={testText} maxLength={300} onChange={e => setTestText(e.target.value)}/><button onClick={preview}><Play size={14}/>Probar voz</button></div></section>}
  {page === 'Reglas de lectura' && <section className="card standalone"><div className="card-heading"><div className="section-title"><ShieldCheck size={19}/><h2>Un chat que suena bien</h2></div><span className="tag">MODERACIÓN</span></div><p className="muted">Los cambios se aplican a los nuevos mensajes. La cola admite hasta 50 mensajes.</p>{Rules()}</section>}
  {page === 'Actividad' && <section className="card standalone"><div className="card-heading"><div className="section-title"><MessageSquare size={19}/><h2>Mensajes de la sesión</h2></div><span className="tag">{history.length} RECIENTES</span></div>{Activity()}</section>}
  {page === 'Configuración' && <section className="card standalone"><div className="card-heading"><div className="section-title"><Settings2 size={19}/><h2>Preferencias del estudio</h2></div></div><div className="rule-grid"><div className="field"><label htmlFor="settings-command">Comando de lectura</label><input id="settings-command" maxLength={20} value={settings.command} onChange={e => patch('command', e.target.value.replace(/\s/g,''))}/></div><div className="field"><label>Voz seleccionada</label><button className="button secondary" onClick={() => setVoiceModal(true)}>{voiceName}<ChevronDown size={15}/></button></div></div><Toggle settings={settings} patch={patch} label="Leer nombre de usuario" detail="Anuncia quién envía cada mensaje." prop="readName"/><div className="info-box"><ShieldCheck size={20}/><p>Los ajustes se guardan para este navegador mediante una cookie privada. La actividad y la cola son temporales y se vacían al cerrar o recargar la página.</p></div><button className="button secondary" onClick={() => { changed.current = true; setSettings(defaults); setDirty(true); notice('Preferencias restablecidas. Guarda los cambios para conservarlas.'); }}>Restablecer preferencias</button></section>}
  <footer className="main-footer"><span><i/> Menos distracciones. Más comunidad.</span><span>Creado para streamers de <b>KICK</b><ArrowUpRight size={12}/></span></footer></main></div>
  {toast && <div className="toast" role="status"><CheckCheck size={18}/>{toast}<button onClick={() => setToast('')} aria-label="Cerrar notificación"><X size={15}/></button></div>}
  {voiceModal && <div className="modal-backdrop" onClick={() => setVoiceModal(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="voice-modal-title" onClick={e => e.stopPropagation()}><div className="card-heading"><div><h2 id="voice-modal-title">Encuentra tu voz</h2><p className="muted">Voces disponibles en tu dispositivo.</p></div><button autoFocus className="icon-button" aria-label="Cerrar voces" onClick={() => setVoiceModal(false)}><X size={20}/></button></div><input className="search" placeholder="Buscar por nombre o idioma…" aria-label="Buscar voz" value={search} onChange={e => setSearch(e.target.value)}/><div className="voice-library">{voices.filter(v => `${v.name} ${v.lang}`.toLowerCase().includes(search.toLowerCase())).map((v,i) => <VoiceCard selectedVoice={selectedVoice} patch={patch} key={v.voiceURI} voice={v} index={i}/>)}</div>{!voices.length && <p className="muted">Tu navegador aún no tiene voces disponibles. Prueba con Chrome o Edge e instala un idioma de voz en los ajustes del sistema.</p>}<button className="button primary modal-done" onClick={() => setVoiceModal(false)}><Check size={16}/>Usar esta voz</button></section></div>}
  {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><div className="card-heading"><h2 id="help-title">Tu primer directo con Kivoz</h2><button autoFocus className="icon-button" aria-label="Cerrar ayuda" onClick={() => setHelp(false)}><X size={20}/></button></div><ol><li><strong>Conecta tu comunidad</strong><p>Introduce el nombre del canal de Kick y pulsa Conectar canal. No necesitas compartir tu contraseña.</p></li><li><strong>Dale tu toque</strong><p>Elige una voz, ajusta el tono y prueba el audio. El comando inicial es !aa y puedes cambiarlo cuando quieras.</p></li><li><strong>Deja que hable el chat</strong><p>Un mensaje como «!aa ¡Hola!» se añade a la cola. Mantén esta pestaña abierta y con sonido. Usa OBS para capturar el audio del navegador si lo quieres en tu directo.</p></li></ol><div className="info-box"><CircleHelp size={20}/><p>La conexión utiliza el chat público de Kick y puede verse limitada si Kick cambia o bloquea su acceso. Si no se conecta, aparece un aviso; no se simulan mensajes. La lectura requiere un navegador compatible con Web Speech.</p></div><button className="button primary" onClick={() => setHelp(false)}>Todo listo <ArrowRight size={16}/></button></section></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
