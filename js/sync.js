// Sincronización con Supabase. El dispositivo guarda todo primero (funciona sin
// señal) y acá se suben los cambios marcados y se bajan los del resto.
import * as db from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const enabled = Boolean(SUPABASE_URL && SUPABASE_KEY && window.supabase);
export const client = enabled
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const BUCKET = 'media';
let running = null;
let status = { state: 'idle', pending: 0, error: '' };
const listeners = new Set();

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

// ---------- Sesión y perfil ----------

// El perfil queda guardado en el dispositivo para poder usar la app sin señal.
export async function profile() {
  return db.getSetting('profile', null);
}

export async function isAdmin() {
  const p = await profile();
  return !enabled || (p && p.role === 'admin');
}

async function loadProfile(userId) {
  const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  await db.setSetting('profile', data);
  await db.setSetting('author', data.name);
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authMessage(error));
  await afterLogin(data.user);
}

export async function signUp(email, password, name) {
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { name } } });
  if (error) throw new Error(authMessage(error));
  if (!data.session) throw new Error('Revisá tu mail para confirmar la cuenta y después iniciá sesión.');
  await afterLogin(data.user);
}

async function afterLogin(user) {
  const p = await loadProfile(user.id);
  // La primera vez, lo que ya estaba cargado en este dispositivo se sube con este usuario.
  const key = `migrated-${user.id}`;
  if (!(await db.getSetting(key))) {
    const local = (await db.all('campaigns')).filter((r) => !r.remote && !r.deleted).length +
      (await db.all('notes')).filter((r) => !r.remote && !r.deleted).length;
    const upload = !local || confirm('Este dispositivo tiene campañas o notas cargadas antes de iniciar sesión. ¿Subirlas a tu cuenta?\n\nAceptar: se suben.\nCancelar: se descartan (si eran pruebas o ya las subiste desde otro equipo).');
    for (const name of ['campaigns', 'lots', 'notes', 'media']) {
      for (const r of await db.all(name)) {
        if (r.remote) continue;
        if (!upload) { await db.remove(name, r.id); continue; }
        if (name === 'notes' && !r.authorId) { r.authorId = user.id; r.author = r.author || p.name; }
        r.dirty = 1;
        await db.put(name, r);
      }
    }
    await db.setSetting(key, true);
  }
}

export async function signOut() {
  if (client) await client.auth.signOut().catch(() => {});
  await db.clearAll();
}

export async function updateName(name) {
  const p = await profile();
  await db.setSetting('author', name);
  if (!p) return;
  p.name = name;
  await db.setSetting('profile', p);
  const { error } = await client.from('profiles').update({ name }).eq('id', p.id);
  if (error) throw error;
}

function authMessage(error) {
  const m = (error.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Mail o contraseña incorrectos.';
  if (m.includes('already registered')) return 'Ese mail ya tiene cuenta. Iniciá sesión.';
  if (m.includes('password')) return 'La contraseña tiene que tener al menos 6 caracteres.';
  if (m.includes('email not confirmed')) return 'Falta confirmar el mail (revisá tu correo).';
  return error.message;
}

// ---------- Conversión entre el dispositivo y el servidor ----------

const iso = (ts) => (ts ? new Date(ts).toISOString() : null);
const ms = (s) => (s ? Date.parse(s) : null);

const NOTE_LOCAL_ONLY = ['id', 'lotId', 'authorId', 'createdAt', 'dirty', 'remote', 'deleted'];

const TABLES = {
  campaigns: {
    toRow: (r) => ({ id: r.id, name: r.name, created_at: iso(r.createdAt), deleted: !!r.deleted }),
    fromRow: (row) => ({ id: row.id, name: row.name, createdAt: ms(row.created_at), deleted: row.deleted }),
  },
  lots: {
    toRow: (r) => ({ id: r.id, campaign_id: r.campaignId, name: r.name, crop: r.crop || null, geometry: r.geometry, created_at: iso(r.createdAt), deleted: !!r.deleted }),
    fromRow: (row) => ({ id: row.id, campaignId: row.campaign_id, name: row.name, crop: row.crop || '', geometry: row.geometry, createdAt: ms(row.created_at), deleted: row.deleted }),
  },
  notes: {
    toRow: (r) => {
      const data = {};
      for (const [k, v] of Object.entries(r)) if (!NOTE_LOCAL_ONLY.includes(k)) data[k] = v;
      return { id: r.id, lot_id: r.lotId, author_id: r.authorId, data, visit_at: iso(r.visitAt), created_at: iso(r.createdAt), deleted: !!r.deleted };
    },
    fromRow: (row) => ({ ...row.data, id: row.id, lotId: row.lot_id, authorId: row.author_id, createdAt: ms(row.created_at), deleted: row.deleted }),
  },
  media: {
    toRow: (r) => ({
      id: r.id, note_id: r.noteId, lot_id: r.lotId, type: r.type, mime: r.mime, path: r.path,
      lat: r.lat, lng: r.lng, accuracy: r.accuracy, loc_source: r.locSource, taken_at: iso(r.takenAt),
      created_at: iso(r.createdAt), deleted: !!r.deleted,
    }),
    fromRow: (row, local) => ({
      id: row.id, noteId: row.note_id, lotId: row.lot_id, type: row.type, mime: row.mime, path: row.path,
      lat: row.lat, lng: row.lng, accuracy: row.accuracy, locSource: row.loc_source, takenAt: ms(row.taken_at),
      transcript: row.transcript, summary: row.summary, createdAt: ms(row.created_at), deleted: row.deleted,
      blob: row.deleted ? null : (local && local.blob) || null,
    }),
  },
};

// Error de permisos o de lote inexistente: no tiene sentido reintentar.
function isPermanent(error) {
  return ['42501', '23503', '23502', 'PGRST116'].includes(error.code) || error.status === 403;
}

function extension(mime) {
  if (!mime) return 'bin';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('mp4')) return mime.startsWith('audio') ? 'm4a' : 'mp4';
  if (mime.includes('webm')) return 'webm';
  return mime.split('/')[1] || 'bin';
}

// ---------- Subida ----------

async function pushTable(name) {
  const { toRow } = TABLES[name];
  const dirty = (await db.all(name)).filter((r) => r.dirty);
  for (const r of dirty) {
    if (name === 'media') {
      if (!r.lotId) r.lotId = ((await db.get('notes', r.noteId)) || {}).lotId;
      if (!r.path) r.path = `${r.lotId}/${r.noteId}/${r.id}.${extension(r.mime)}`;
      if (!r.remote && !r.deleted && r.blob) {
        const up = await client.storage.from(BUCKET).upload(r.path, r.blob, { contentType: r.mime || undefined, upsert: true });
        if (up.error) {
          if (isPermanent(up.error) || /row-level|policy/i.test(up.error.message)) { r.dirty = 0; await db.put(name, r); console.warn('No se pudo subir el archivo', r.id, up.error.message); continue; }
          throw up.error;
        }
      }
    }
    const row = toRow(r);
    let res;
    if (r.remote) {
      // Ya existe en el servidor: se actualiza sin tocar el autor.
      delete row.author_id;
      res = await client.from(name).update(row).eq('id', r.id);
    } else {
      res = await client.from(name).upsert(row);
    }
    if (res.error) {
      if (!isPermanent(res.error)) throw res.error;
      console.warn('No se pudo subir', name, r.id, res.error.message);
    } else if (name === 'media' && !r.remote && r.type === 'audio' && !r.deleted) {
      requestTranscription(r.id);
    }
    // Si se editó mientras subía, queda marcado para la próxima vuelta.
    const latest = (await db.get(name, r.id)) || r;
    if ((latest.rev || 0) === (r.rev || 0)) latest.dirty = 0;
    latest.remote = !res.error;
    if (name === 'media') Object.assign(latest, { lotId: r.lotId, path: r.path });
    await db.put(name, latest);
  }
}

// ---------- Bajada ----------

async function pullTable(name) {
  const { fromRow } = TABLES[name];
  const cursorKey = `pull-${name}`;
  let since = await db.getSetting(cursorKey, '1970-01-01T00:00:00Z');
  let changed = 0;
  for (;;) {
    // Margen de 5 segundos para no perder filas guardadas casi al mismo tiempo.
    const from = new Date(Date.parse(since) - 5000).toISOString();
    const { data, error } = await client.from(name).select('*').gt('updated_at', from).order('updated_at').limit(500);
    if (error) throw error;
    for (const row of data) {
      const local = await db.get(name, row.id);
      if (local && local.dirty) continue; // lo local todavía no subió: gana lo local
      const next = { ...fromRow(row, local), remote: true, dirty: 0 };
      if (!local || JSON.stringify({ ...local, blob: null }) !== JSON.stringify({ ...next, blob: null })) changed++;
      await db.put(name, next);
    }
    if (data.length) since = data[data.length - 1].updated_at;
    await db.setSetting(cursorKey, since);
    if (data.length < 500) break;
  }
  return changed;
}

// Fotos y audios se bajan para verlos sin señal; los videos, solo al abrirlos.
async function downloadMedia() {
  const missing = (await db.all('media')).filter((m) => !m.deleted && !m.blob && m.path && m.type !== 'video');
  for (const m of missing) {
    const { data, error } = await client.storage.from(BUCKET).download(m.path);
    if (error) continue;
    m.blob = data;
    await db.put('media', m);
  }
  return missing.length;
}

export async function mediaUrl(m) {
  if (!client || !m.path) return '';
  const { data } = await client.storage.from(BUCKET).createSignedUrl(m.path, 3600);
  return data ? data.signedUrl : '';
}

// ---------- Transcripción ----------

export async function requestTranscription(mediaId) {
  if (!client) return null;
  const { data, error } = await client.functions.invoke('transcribe', { body: { media_id: mediaId } });
  if (error || !data) {
    // Trae el detalle del error para poder mostrarlo.
    let detail = error ? error.message : 'Sin respuesta';
    try {
      const body = await error.context.text();
      try { detail = JSON.parse(body).error || JSON.parse(body).message || body; } catch { detail = body || detail; }
      detail = `${error.context.status}: ${detail}`;
    } catch {}
    return { error: String(detail).slice(0, 300) };
  }
  const m = await db.get('media', mediaId);
  if (m && data.transcript) {
    m.transcript = data.transcript;
    m.summary = data.summary;
    await db.put('media', m);
  }
  return data;
}

// ---------- Ciclo completo ----------

export async function syncNow() {
  if (!enabled || !(await profile())) return { changed: 0 };
  if (running) return running;
  running = (async () => {
    if (!navigator.onLine) {
      setStatus({ state: 'offline', pending: await db.pendingCount() });
      return { changed: 0 };
    }
    setStatus({ state: 'syncing' });
    try {
      const { data } = await client.auth.getSession();
      if (!data.session) throw new Error('La sesión venció. Volvé a iniciar sesión desde Ajustes.');
      for (const name of ['campaigns', 'lots', 'notes', 'media']) await pushTable(name);
      let changed = 0;
      for (const name of ['campaigns', 'lots', 'notes', 'media']) changed += await pullTable(name);
      changed += await downloadMedia();
      await db.setSetting('lastSync', Date.now());
      setStatus({ state: 'ok', pending: await db.pendingCount(), error: '' });
      return { changed };
    } catch (err) {
      console.error(err);
      setStatus({ state: 'error', pending: await db.pendingCount(), error: err.message || String(err) });
      return { changed: 0 };
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- Administración de usuarios ----------

export async function listUsers() {
  const [{ data: users, error: e1 }, { data: access, error: e2 }] = await Promise.all([
    client.from('profiles').select('*').order('created_at'),
    client.from('lot_access').select('*'),
  ]);
  if (e1 || e2) throw e1 || e2;
  return { users, access };
}

export async function setAccess(userId, lotIds, allowed) {
  if (!lotIds.length) return;
  const res = allowed
    ? await client.from('lot_access').upsert(lotIds.map((lot_id) => ({ user_id: userId, lot_id })))
    : await client.from('lot_access').delete().eq('user_id', userId).in('lot_id', lotIds);
  if (res.error) throw res.error;
}

export async function setRole(userId, role) {
  const { error } = await client.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}
