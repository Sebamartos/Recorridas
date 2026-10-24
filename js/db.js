// Almacenamiento local en IndexedDB. Todo queda en el dispositivo hasta que
// sumemos sincronización.

const DB_NAME = 'recorridas';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('campaigns', { keyPath: 'id' });
      const lots = db.createObjectStore('lots', { keyPath: 'id' });
      lots.createIndex('campaignId', 'campaignId');
      const notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('lotId', 'lotId');
      const media = db.createObjectStore('media', { keyPath: 'id' });
      media.createIndex('noteId', 'noteId');
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function put(name, value) {
  return wrap((await store(name, 'readwrite')).put(value));
}

export async function get(name, id) {
  return wrap((await store(name)).get(id));
}

export async function all(name) {
  return wrap((await store(name)).getAll());
}

export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function remove(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}

export async function getSetting(key, fallback = null) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return put('settings', { key, value });
}

// Guarda un registro propio y lo marca para subirlo en la próxima sincronización.
export async function save(name, value) {
  value.dirty = 1;
  value.rev = (value.rev || 0) + 1;
  return put(name, value);
}

// Los borrados son marcas: así la sincronización puede avisarle al resto.
export async function deleteNote(noteId) {
  const note = await get('notes', noteId);
  if (!note) return;
  for (const m of await byIndex('media', 'noteId', noteId)) {
    m.deleted = true;
    m.blob = null;
    await save('media', m);
  }
  note.deleted = true;
  await save('notes', note);
}

export async function deleteLot(lotId) {
  const lot = await get('lots', lotId);
  if (!lot) return;
  for (const n of await byIndex('notes', 'lotId', lotId)) await deleteNote(n.id);
  lot.deleted = true;
  await save('lots', lot);
}

export async function deleteCampaign(campaignId) {
  const campaign = await get('campaigns', campaignId);
  if (!campaign) return;
  for (const lot of await byIndex('lots', 'campaignId', campaignId)) await deleteLot(lot.id);
  campaign.deleted = true;
  await save('campaigns', campaign);
}

export async function pendingCount() {
  let n = 0;
  for (const name of ['campaigns', 'lots', 'notes', 'media']) n += (await all(name)).filter((r) => r.dirty).length;
  return n;
}

// Borra todos los datos del dispositivo (al cerrar sesión).
export async function clearAll() {
  const db = await open();
  const names = ['campaigns', 'lots', 'notes', 'media', 'settings'];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    names.forEach((n) => tx.objectStore(n).clear());
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Pide al navegador que no borre los datos si falta espacio.
export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
