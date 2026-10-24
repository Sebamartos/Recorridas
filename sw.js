// Guarda la app en el dispositivo para que abra sin señal.
// Subí VERSION en cada cambio para que los teléfonos tomen la versión nueva.
const VERSION = 'v17';
const APP_CACHE = `app-${VERSION}`;
const TILE_CACHE = 'tiles';
const MAX_TILES = 3000;

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/geo.js',
  'js/crops.js',
  'js/combo.js',
  'js/mediageo.js',
  'js/sync.js',
  'js/config.js',
  'vendor/supabase/supabase.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/togeojson/togeojson.umd.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/icon-maskable.png',
  'icons/logo.png',
  'icons/mark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('app-') && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Imágenes satelitales: se guardan las que ya viste para usarlas sin señal.
  if (url.hostname === 'server.arcgisonline.com') {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        try {
          const res = await fetch(event.request);
          if (res.ok || res.type === 'opaque') { cache.put(event.request, res.clone()); trimTiles(); }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Archivos de la app: primero la red (para tomar cambios), si no hay señal, lo guardado.
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
