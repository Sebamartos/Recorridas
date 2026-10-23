import * as db from './db.js';
import { parseLotsFile, containsPoint, areaHa, getPosition } from './geo.js';

const L = window.L;
const app = document.getElementById('app');

const PHENOLOGY = ['VE', 'VC', 'V1', 'V2', 'V3', 'V4', 'V6', 'V8', 'V10', 'VT', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'Macollaje', 'Encañazón', 'Espigazón', 'Floración', 'Llenado', 'Madurez'];
const PESTS = ['Chinche', 'Isoca bolillera', 'Oruga militar', 'Cogollero', 'Trips', 'Arañuela', 'Pulgón', 'Chicharrita', 'Mancha ojo de rana', 'Roya', 'Tizón', 'Malezas', 'Sin plagas'];
const DAMAGE = [
  ['', '—'],
  ['0', 'Sin daño'],
  ['1', 'Bajo'],
  ['2', 'Medio'],
  ['3', 'Alto'],
];
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTR = 'Imágenes © Esri';

// URLs de blobs abiertas en la vista actual; se liberan al cambiar de pantalla.
let objectUrls = [];
let activeMap = null;

function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function cleanup() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  if (activeMap) { activeMap.remove(); activeMap = null; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts, withTime = true) {
  const d = new Date(ts);
  const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('es-AR', opts);
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function makeMap(el, { interactive = true } = {}) {
  const map = L.map(el, { zoomControl: interactive, attributionControl: true, dragging: interactive, scrollWheelZoom: interactive });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
  activeMap = map;
  return map;
}

// ---------- Datos ----------

async function currentCampaign() {
  const campaigns = (await db.all('campaigns')).sort((a, b) => b.createdAt - a.createdAt);
  let id = await db.getSetting('campaignId');
  if (!campaigns.find((c) => c.id === id)) id = campaigns[0] && campaigns[0].id;
  return { campaigns, campaign: campaigns.find((c) => c.id === id) || null };
}

async function lotsOf(campaignId) {
  if (!campaignId) return [];
  const lots = await db.byIndex('lots', 'campaignId', campaignId);
  return lots.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

async function author() {
  let name = await db.getSetting('author');
  if (!name) {
    name = (prompt('¿Cómo te llamás? (aparece en tus notas)') || '').trim() || 'Sin nombre';
    await db.setSetting('author', name);
  }
  return name;
}

// ---------- Inicio ----------

async function viewHome() {
  const { campaigns, campaign } = await currentCampaign();
  const lots = await lotsOf(campaign && campaign.id);
  const stats = {};
  for (const lot of lots) {
    const notes = await db.byIndex('notes', 'lotId', lot.id);
    stats[lot.id] = { count: notes.length, last: notes.reduce((m, n) => Math.max(m, n.createdAt), 0) };
  }

  app.innerHTML = `
    <header class="bar">
      <h1>Recorridas</h1>
      <a class="icon-btn" href="#/ajustes" aria-label="Ajustes">⚙︎</a>
    </header>
    <main class="page">
      <div class="row">
        <select id="campaign" class="grow" aria-label="Campaña">
          ${campaigns.map((c) => `<option value="${c.id}" ${campaign && c.id === campaign.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          <option value="__new">＋ Nueva campaña…</option>
        </select>
      </div>
      ${campaign ? `
        <div id="map" class="map"></div>
        <div class="row">
          <button id="quick" class="btn primary grow">＋ Nota rápida (por GPS)</button>
        </div>
        <ul class="list">
          ${lots.map((l) => `
            <li><a href="#/lote/${l.id}">
              <div><strong>${esc(l.name)}</strong>${l.crop ? ` · ${esc(l.crop)}` : ''}</div>
              <div class="muted">${areaHa(l.geometry).toFixed(1)} ha · ${stats[l.id].count} notas${stats[l.id].last ? ` · última ${fmtDate(stats[l.id].last, false)}` : ''}</div>
            </a></li>`).join('') || '<li class="empty">Todavía no hay lotes en esta campaña.</li>'}
        </ul>
        <label class="btn">Importar lotes (KML o KMZ)<input id="kml" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" hidden></label>
      ` : `
        <div class="empty">Creá tu primera campaña para empezar, por ejemplo “2026/27”.</div>
      `}
    </main>`;

  document.getElementById('campaign').addEventListener('change', async (e) => {
    if (e.target.value === '__new') {
      const name = (prompt('Nombre de la campaña (ej: 2026/27)') || '').trim();
      if (name) {
        const c = { id: db.uid(), name, createdAt: Date.now() };
        await db.put('campaigns', c);
        await db.setSetting('campaignId', c.id);
      }
    } else {
      await db.setSetting('campaignId', e.target.value);
    }
    render();
  });

  if (!campaign) {
    if (!campaigns.length) document.getElementById('campaign').value = '__new';
    return;
  }

  document.getElementById('kml').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = await parseLotsFile(file);
      for (const p of parsed) {
        await db.put('lots', { id: db.uid(), campaignId: campaign.id, name: p.name, crop: '', geometry: p.geometry, createdAt: Date.now() });
      }
      toast(`Se importaron ${parsed.length} lotes`);
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('quick').addEventListener('click', async () => {
    toast('Buscando tu ubicación…');
    const pos = await getPosition();
    if (!pos) return alert('No se pudo obtener la ubicación. Elegí el lote de la lista.');
    const lot = lots.find((l) => containsPoint(l.geometry, pos.lat, pos.lng));
    if (!lot) return alert('No estás dentro de ningún lote de esta campaña. Elegí el lote de la lista.');
    location.hash = `#/nota/nueva/${lot.id}`;
  });

  const map = makeMap(document.getElementById('map'));
  if (lots.length) {
    const group = L.featureGroup(lots.map((l) =>
      L.geoJSON(l.geometry, { style: { color: '#ffd54a', weight: 2, fillOpacity: 0.15 } })
        .bindTooltip(l.name, { permanent: lots.length <= 30, direction: 'center', className: 'lot-label' })
        .on('click', () => { location.hash = `#/lote/${l.id}`; })
    )).addTo(map);
    map.fitBounds(group.getBounds(), { padding: [10, 10] });
  } else {
    map.setView([-34.6, -60.5], 6);
  }
}

// ---------- Lote ----------

async function viewLot(lotId) {
  const lot = await db.get('lots', lotId);
  if (!lot) { location.hash = '#/'; return; }
  const notes = (await db.byIndex('notes', 'lotId', lotId)).sort((a, b) => b.createdAt - a.createdAt);
  const mediaByNote = {};
  for (const n of notes) mediaByNote[n.id] = await db.byIndex('media', 'noteId', n.id);

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Volver">‹</a>
      <h1>${esc(lot.name)}</h1>
      <button class="icon-btn" id="lot-menu" aria-label="Opciones del lote">⋯</button>
    </header>
    <main class="page">
      <div class="muted">${lot.crop ? `Cultivo: <strong>${esc(lot.crop)}</strong> · ` : ''}${areaHa(lot.geometry).toFixed(1)} ha</div>
      <div id="map" class="map small"></div>
      <a class="btn primary" href="#/nota/nueva/${lot.id}">＋ Nueva nota</a>
      <section class="timeline">
        ${notes.map((n) => noteCard(n, mediaByNote[n.id])).join('') || '<div class="empty">Sin notas todavía.</div>'}
      </section>
    </main>`;

  const map = makeMap(document.getElementById('map'));
  const shape = L.geoJSON(lot.geometry, { style: { color: '#ffd54a', weight: 2, fillOpacity: 0.1 } }).addTo(map);
  map.fitBounds(shape.getBounds(), { padding: [10, 10] });
  for (const n of notes) {
    const pts = [n, ...mediaByNote[n.id]].filter((p) => p.lat != null);
    pts.forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 })
      .bindPopup(`${fmtDate(n.createdAt)}<br>${esc((n.text || '').slice(0, 80))}`).addTo(map));
  }

  document.getElementById('lot-menu').addEventListener('click', async () => {
    const choice = prompt('Escribí 1 para cambiar el cultivo, 2 para renombrar el lote, 3 para borrar el lote');
    if (choice === '1') {
      const crop = prompt('Cultivo del lote (ej: Soja 1ra, Maíz tardío)', lot.crop || '');
      if (crop !== null) { lot.crop = crop.trim(); await db.put('lots', lot); render(); }
    } else if (choice === '2') {
      const name = prompt('Nombre del lote', lot.name);
      if (name && name.trim()) { lot.name = name.trim(); await db.put('lots', lot); render(); }
    } else if (choice === '3') {
      if (confirm(`¿Borrar el lote “${lot.name}” y todas sus notas? No se puede deshacer.`)) {
        await db.deleteLot(lot.id);
        location.hash = '#/';
      }
    }
  });

  bindNoteCards();
}

function noteCard(n, media) {
  const chips = [
    n.phenology && `<span class="chip">${esc(n.phenology)}</span>`,
    n.pest && `<span class="chip warn">${esc(n.pest)}</span>`,
    n.damage !== '' && n.damage != null && `<span class="chip dmg-${esc(n.damage)}">Daño: ${esc((DAMAGE.find((d) => d[0] === n.damage) || [])[1])}</span>`,
  ].filter(Boolean).join('');
  const photos = media.filter((m) => m.type === 'photo');
  const audios = media.filter((m) => m.type === 'audio');
  const videos = media.filter((m) => m.type === 'video');
  return `
    <article class="card" data-note="${n.id}">
      <header>
        <span>${fmtDate(n.createdAt)}</span>
        <span class="muted">${esc(n.author)}</span>
        <button class="link danger" data-delete="${n.id}" aria-label="Borrar nota">Borrar</button>
      </header>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      ${n.text ? `<p class="text">${esc(n.text)}</p>` : ''}
      ${photos.length ? `<div class="thumbs">${photos.map((m) => `<img src="${blobUrl(m.blob)}" alt="Foto" data-full loading="lazy">`).join('')}</div>` : ''}
      ${audios.map((m) => `<audio controls preload="metadata" src="${blobUrl(m.blob)}"></audio>`).join('')}
      ${videos.map((m) => `<video controls playsinline preload="metadata" src="${blobUrl(m.blob)}"></video>`).join('')}
      ${n.lat != null ? `<div class="muted small">📍 ${n.lat.toFixed(5)}, ${n.lng.toFixed(5)} (±${n.accuracy} m)</div>` : ''}
    </article>`;
}

function bindNoteCards() {
  app.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (confirm('¿Borrar esta nota? No se puede deshacer.')) {
      await db.deleteNote(btn.dataset.delete);
      render();
    }
  }));
  app.querySelectorAll('img[data-full]').forEach((img) => img.addEventListener('click', () => {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${img.src}" alt="Foto">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }));
}

// ---------- Nueva nota ----------

async function compressImage(file, maxSide = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob((b) => res(b || file), 'image/jpeg', 0.8));
  } catch {
    return file;
  }
}

async function viewNewNote(lotId) {
  const lot = await db.get('lots', lotId);
  if (!lot) { location.hash = '#/'; return; }
  const me = await author();
  const pending = []; // { type, blob, mime, lat, lng, accuracy, createdAt }
  let notePos = null;
  let recorder = null;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/lote/${lot.id}" aria-label="Cancelar">‹</a>
      <h1>Nueva nota · ${esc(lot.name)}</h1>
    </header>
    <main class="page form">
      <div id="gps" class="muted small">📍 Buscando ubicación…</div>
      <label>Lo que viste
        <textarea id="text" rows="5" placeholder="Estado del cultivo, plagas, malezas, humedad…"></textarea>
      </label>
      <div class="grid3">
        <label>Estado fenológico
          <input id="phenology" list="phen-list" placeholder="ej: V6, R3">
          <datalist id="phen-list">${PHENOLOGY.map((p) => `<option value="${p}">`).join('')}</datalist>
        </label>
        <label>Plaga / enfermedad
          <input id="pest" list="pest-list" placeholder="ej: Chinche">
          <datalist id="pest-list">${PESTS.map((p) => `<option value="${p}">`).join('')}</datalist>
        </label>
        <label>Nivel de daño
          <select id="damage">${DAMAGE.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
        </label>
      </div>
      <div class="media-buttons">
        <label class="btn">📷 Foto<input id="photo" type="file" accept="image/*" capture="environment" multiple hidden></label>
        <label class="btn">🎥 Video<input id="video" type="file" accept="video/*" capture="environment" hidden></label>
        <button id="rec" class="btn">🎙️ Grabar audio</button>
      </div>
      <div id="pending" class="pending"></div>
      <button id="save" class="btn primary">Guardar nota</button>
    </main>`;

  const gpsEl = document.getElementById('gps');
  getPosition().then((pos) => {
    notePos = pos;
    if (!pos) { gpsEl.textContent = '📍 Sin ubicación (revisá los permisos de GPS)'; return; }
    const inside = containsPoint(lot.geometry, pos.lat, pos.lng);
    gpsEl.textContent = `📍 ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${pos.accuracy} m)${inside ? '' : ' · fuera del lote'}`;
  });

  function renderPending() {
    const el = document.getElementById('pending');
    el.innerHTML = pending.map((m, i) => `
      <div class="pending-item">
        ${m.type === 'photo' ? `<img src="${blobUrl(m.blob)}" alt="">` : m.type === 'audio' ? `<audio controls src="${blobUrl(m.blob)}"></audio>` : `<video src="${blobUrl(m.blob)}" playsinline muted></video>`}
        <button class="link danger" data-rm="${i}">Quitar</button>
      </div>`).join('');
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { pending.splice(Number(b.dataset.rm), 1); renderPending(); }));
  }

  async function addMedia(type, blob) {
    // Cada archivo lleva la ubicación del momento en que se agregó.
    const pos = (await getPosition(8000)) || notePos;
    pending.push({ type, blob, mime: blob.type, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, accuracy: pos ? pos.accuracy : null, createdAt: Date.now() });
    renderPending();
  }

  document.getElementById('photo').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMedia('photo', await compressImage(f));
    e.target.value = '';
  });

  document.getElementById('video').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) {
      if (f.size > 100 * 1024 * 1024) alert('El video es muy pesado (más de 100 MB). Probá con uno más corto.');
      else await addMedia('video', f);
    }
    e.target.value = '';
  });

  const recBtn = document.getElementById('rec');
  recBtn.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      const started = Date.now();
      const timer = setInterval(() => { recBtn.textContent = `⏹ Detener (${Math.round((Date.now() - started) / 1000)} s)`; }, 500);
      recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      recorder.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        recBtn.textContent = '🎙️ Grabar audio';
        recBtn.classList.remove('recording');
        await addMedia('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }));
      };
      recorder.start();
      recBtn.classList.add('recording');
      recBtn.textContent = '⏹ Detener (0 s)';
    } catch {
      alert('No se pudo usar el micrófono. Revisá los permisos.');
    }
  });

  document.getElementById('save').addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') return alert('Primero detené la grabación.');
    const note = {
      id: db.uid(),
      lotId: lot.id,
      createdAt: Date.now(),
      author: me,
      text: document.getElementById('text').value.trim(),
      phenology: document.getElementById('phenology').value.trim(),
      pest: document.getElementById('pest').value.trim(),
      damage: document.getElementById('damage').value,
      lat: notePos ? notePos.lat : null,
      lng: notePos ? notePos.lng : null,
      accuracy: notePos ? notePos.accuracy : null,
    };
    if (!note.text && !note.phenology && !note.pest && !note.damage && !pending.length) return alert('La nota está vacía.');
    await db.put('notes', note);
    for (const m of pending) await db.put('media', { id: db.uid(), noteId: note.id, ...m });
    toast('Nota guardada');
    location.hash = `#/lote/${lot.id}`;
  });
}

// ---------- Ajustes ----------

async function viewSettings() {
  const name = await db.getSetting('author', '');
  const { campaign } = await currentCampaign();
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1048576).toFixed(1)} MB usados`;
  }
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Volver">‹</a>
      <h1>Ajustes</h1>
    </header>
    <main class="page form">
      <label>Tu nombre (aparece en tus notas)
        <input id="author" value="${esc(name)}">
      </label>
      <button id="save-author" class="btn">Guardar nombre</button>
      <p class="muted">Almacenamiento: ${usage || 'sin datos'}${persisted ? ' · protegido' : ''}.</p>
      <p class="muted">Por ahora las notas se guardan solo en este dispositivo. Más adelante se van a sincronizar entre usuarios.</p>
      ${campaign ? `<button id="del-campaign" class="btn danger">Borrar campaña “${esc(campaign.name)}”</button>` : ''}
    </main>`;

  document.getElementById('save-author').addEventListener('click', async () => {
    await db.setSetting('author', document.getElementById('author').value.trim() || 'Sin nombre');
    toast('Guardado');
  });
  const del = document.getElementById('del-campaign');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`¿Borrar la campaña “${campaign.name}” con todos sus lotes y notas? No se puede deshacer.`)) return;
    for (const lot of await lotsOf(campaign.id)) await db.deleteLot(lot.id);
    await db.remove('campaigns', campaign.id);
    location.hash = '#/';
  });
}

// ---------- Router ----------

async function render() {
  cleanup();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'lote' && parts[1]) await viewLot(parts[1]);
    else if (parts[0] === 'nota' && parts[1] === 'nueva' && parts[2]) await viewNewNote(parts[2]);
    else if (parts[0] === 'ajustes') await viewSettings();
    else await viewHome();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<main class="page"><p>Ocurrió un error: ${esc(err.message)}</p><a class="btn" href="#/">Volver al inicio</a></main>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
db.requestPersistence();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
