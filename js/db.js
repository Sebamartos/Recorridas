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

export async function deleteNote(noteId) {
  const media = await byIndex('media', 'noteId', noteId);
  for (const m of media) await remove('media', m.id);
  await remove('notes', noteId);
}

export async function deleteLot(lotId) {
  const notes = await byIndex('notes', 'lotId', lotId);
  for (const n of notes) await deleteNote(n.id);
  await remove('lots', lotId);
}

// Pide al navegador que no borre los datos si falta espacio.
export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
