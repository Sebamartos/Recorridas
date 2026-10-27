import * as db from './db.js';
import { parseLotsFile, containsPoint, areaHa, getPosition } from './geo.js';
import { CROPS, WEEDS, cropKey, cropName } from './crops.js';
import { combo, addCustomOption } from './combo.js';
import { photoMeta, videoMeta } from './mediageo.js';
import * as sync from './sync.js';
import { editPhoto } from './photoedit.js';

const L = window.L;
const app = document.getElementById('app');

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
let lotQuery = ''; // búsqueda de lotes, se mantiene al volver al inicio
let activeMap = null;

function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function cleanup() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  if (activeMap) { activeMap.stop(); activeMap.remove(); activeMap = null; }
}

const APP_VERSION = '22';

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

const live = (list) => list.filter((r) => !r.deleted);

async function currentCampaign() {
  const campaigns = live(await db.all('campaigns')).sort((a, b) => b.createdAt - a.createdAt);
  let id = await db.getSetting('campaignId');
  if (!campaigns.find((c) => c.id === id)) id = campaigns[0] && campaigns[0].id;
  return { campaigns, campaign: campaigns.find((c) => c.id === id) || null };
}

async function lotsOf(campaignId) {
  if (!campaignId) return [];
  const lots = live(await db.byIndex('lots', 'campaignId', campaignId));
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
  const admin = await sync.isAdmin();
  const stats = {};
  for (const lot of lots) {
    const notes = live(await db.byIndex('notes', 'lotId', lot.id));
    stats[lot.id] = {
      count: notes.length,
      last: notes.reduce((m, n) => Math.max(m, when(n)), 0),
      pending: notes.reduce((c, n) => c + (n.actions || []).filter((a) => !a.done).length, 0),
    };
  }

  app.innerHTML = `
    <header class="bar">
      <h1>Recorridas</h1>
      ${sync.enabled ? '<a id="sync-badge" class="sync-badge" href="#/ajustes" aria-label="Estado de sincronización"></a>' : ''}
      <a class="icon-btn" href="#/ajustes" aria-label="Ajustes">⚙︎</a>
    </header>
    <main class="page">
      <img class="home-logo" src="icons/logo.png" alt="Las Nazarenas">
      <div class="row">
        <select id="campaign" class="grow" aria-label="Campaña">
          ${campaigns.map((c) => `<option value="${c.id}" ${campaign && c.id === campaign.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          ${campaigns.length ? '' : '<option value="" selected>Sin campañas</option>'}
          ${admin ? '<option value="__new">＋ Nueva campaña…</option>' : ''}
        </select>
      </div>
      ${campaign ? `
        ${lots.length > 1 ? `<input id="search" type="search" placeholder="🔍 Buscar lote o cultivo…" value="${esc(lotQuery)}" autocomplete="off" enterkeyhint="search">` : ''}
        <div id="map" class="map"></div>
        <div class="row">
          <button id="quick" class="btn primary grow">＋ Nota rápida (por GPS)</button>
        </div>
        <ul class="list">
          ${lots.map((l) => `
            <li data-lot="${l.id}" data-search="${esc(norm(`${l.name} ${cropName(cropKey(l.crop)) || l.crop || ''}`))}"><a href="#/lote/${l.id}">
              <div><strong>${esc(l.name)}</strong>${l.crop ? ` · ${esc(cropName(cropKey(l.crop)) || l.crop)}` : ''}</div>
              <div class="muted">${areaHa(l.geometry).toFixed(1)} ha · ${stats[l.id].count} nota${stats[l.id].count === 1 ? "" : "s"}${stats[l.id].last ? ` · última ${fmtDate(stats[l.id].last, false)}` : ''}</div>
              ${stats[l.id].pending ? `<div class="small late">${stats[l.id].pending} pendiente${stats[l.id].pending > 1 ? 's' : ''}</div>` : ''}
            </a></li>`).join('') || '<li class="empty">Todavía no hay lotes en esta campaña.</li>'}
        </ul>
        <div id="no-match" class="empty" hidden>Ningún lote coincide con la búsqueda.</div>
        ${admin ? '<label class="btn">Importar lotes (KML o KMZ)<input id="kml" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" hidden></label>' : ''}
      ` : `
        ${admin ? `<div class="empty">Creá tu primera campaña para empezar, por ejemplo “2026/27”.</div>
        <button id="first-campaign" class="btn primary">＋ Crear campaña</button>` : `<div class="empty">Todavía no tenés lotes asignados. Pedile al administrador que te dé acceso${sync.enabled ? ' y tocá el ícono de sincronizar' : ''}.</div>`}
      `}
    </main>`;

  async function newCampaign() {
    const name = (prompt('Nombre de la campaña (ej: 2026/27)') || '').trim();
    if (name) {
      const c = { id: db.uid(), name, createdAt: Date.now() };
      await db.save('campaigns', c);
      await db.setSetting('campaignId', c.id);
    }
    render();
  }

  document.getElementById('campaign').addEventListener('change', async (e) => {
    if (e.target.value === '__new') {
      await newCampaign();
      return;
    } else {
      await db.setSetting('campaignId', e.target.value);
    }
    render();
  });

  bindSyncBadge();
  if (!campaign) {
    const first = document.getElementById('first-campaign');
    if (first) first.addEventListener('click', newCampaign);
    return;
  }

  const kml = document.getElementById('kml');
  if (kml) kml.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = await parseLotsFile(file);
      for (const p of parsed) {
        await db.save('lots', { id: db.uid(), campaignId: campaign.id, name: p.name, crop: '', geometry: p.geometry, createdAt: Date.now() });
      }
      afterChange();
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
  const layers = {};
  if (lots.length) {
    const group = L.featureGroup(lots.map((l) => {
      layers[l.id] = L.geoJSON(l.geometry, { style: { color: '#ffd54a', weight: 2, fillOpacity: 0.15 } })
        .bindTooltip(l.name, { permanent: lots.length <= 30, direction: 'center', className: 'lot-label' })
        .on('click', () => { location.hash = `#/lote/${l.id}`; });
      return layers[l.id];
    })).addTo(map);
    map.fitBounds(group.getBounds(), { padding: [10, 10] });
  } else {
    map.setView([-34.6, -60.5], 6);
  }

  const search = document.getElementById('search');
  if (!search) return;
  function applySearch() {
    lotQuery = search.value;
    const words = norm(lotQuery).split(/\s+/).filter(Boolean);
    const matched = [];
    app.querySelectorAll('li[data-lot]').forEach((li) => {
      const ok = words.every((w) => li.dataset.search.includes(w));
      li.hidden = !ok;
      if (ok) matched.push(li.dataset.lot);
      layers[li.dataset.lot].setStyle(ok ? { opacity: 1, fillOpacity: 0.15 } : { opacity: 0.25, fillOpacity: 0.03 });
    });
    document.getElementById('no-match').hidden = matched.length > 0;
    if (words.length && matched.length) {
      map.fitBounds(L.featureGroup(matched.map((id) => layers[id])).getBounds(), { padding: [20, 20], maxZoom: 16, animate: false });
    }
  }
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (e) => {
    // Enter con un solo resultado abre el lote directamente.
    if (e.key !== 'Enter') return;
    const visible = [...app.querySelectorAll('li[data-lot]')].filter((li) => !li.hidden);
    if (visible.length === 1) location.hash = `#/lote/${visible[0].dataset.lot}`;
  });
  if (lotQuery) applySearch();
}

function norm(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ---------- Lote ----------

async function viewLot(lotId) {
  const lot = await db.get('lots', lotId);
  if (!lot || lot.deleted) { location.hash = '#/'; return; }
  const admin = await sync.isAdmin();
  const notes = live(await db.byIndex('notes', 'lotId', lotId)).sort((a, b) => when(b) - when(a) || b.createdAt - a.createdAt);
  const mediaByNote = {};
  for (const n of notes) mediaByNote[n.id] = live(await db.byIndex('media', 'noteId', n.id));

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Volver">‹</a>
      <h1>${esc(lot.name)}</h1>
      ${admin ? '<button class="icon-btn" id="lot-menu" aria-label="Opciones del lote">⋯</button>' : ''}
    </header>
    <main class="page">
      <div class="row">
        <select id="lot-crop" class="grow" aria-label="Cultivo del lote" ${admin ? '' : 'disabled'}>
          <option value="">Cultivo sin definir</option>
          ${Object.entries(CROPS).map(([k, c]) => `<option value="${k}" ${cropKey(lot.crop) === k ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
        <span class="muted">${areaHa(lot.geometry).toFixed(1)} ha</span>
      </div>
      <div id="map" class="map small"></div>
      ${pendingBox(notes)}
      <a class="btn primary" href="#/nota/nueva/${lot.id}">＋ Nueva nota</a>
      <section class="timeline">
        ${notes.map((n) => noteCard(n, mediaByNote[n.id])).join('') || '<div class="empty">Sin notas todavía.</div>'}
      </section>
    </main>`;

  const map = makeMap(document.getElementById('map'));
  const shape = L.geoJSON(lot.geometry, { style: { color: '#ffd54a', weight: 2, fillOpacity: 0.1 } }).addTo(map);
  map.fitBounds(shape.getBounds(), { padding: [10, 10] });
  for (const n of notes) {
    const media = mediaByNote[n.id].filter((m) => m.lat != null);
    media.forEach((m) => {
      const color = { photo: '#1e88e5', video: '#8e24aa', audio: '#f4511e' }[m.type];
      const label = { photo: '📷 Foto', video: '🎥 Video', audio: '🎙️ Audio' }[m.type];
      const body = !m.blob ? '<span class="muted">Abrilo desde la nota</span>'
        : m.type === 'photo' ? `<img src="${blobUrl(m.blob)}" class="popup-img">`
        : m.type === 'audio' ? `<audio controls src="${blobUrl(m.blob)}" class="popup-audio"></audio>` : '';
      L.circleMarker([m.lat, m.lng], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<strong>${label}</strong> · ${fmtDate(m.takenAt || when(n), false)}<br>${body}`, { minWidth: 160 }).addTo(map);
    });
    if (!media.length && n.lat != null) {
      L.circleMarker([n.lat, n.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 })
        .bindPopup(`${fmtDate(when(n), false)}<br>${esc((n.text || '').slice(0, 80))}`).addTo(map);
    }
  }

  document.getElementById('lot-crop').addEventListener('change', async (e) => {
    lot.crop = e.target.value;
    await db.save('lots', lot);
    afterChange();
    toast(e.target.value ? `Cultivo: ${cropName(e.target.value)}` : 'Cultivo sin definir');
  });

  const lotMenu = document.getElementById('lot-menu');
  if (lotMenu) lotMenu.addEventListener('click', async () => {
    const choice = prompt('Escribí 1 para renombrar el lote, 2 para borrar el lote');
    if (choice === '1') {
      const name = prompt('Nombre del lote', lot.name);
      if (name && name.trim()) { lot.name = name.trim(); await db.save('lots', lot); afterChange(); render(); }
    } else if (choice === '2') {
      if (confirm(`¿Borrar el lote “${lot.name}” y todas sus notas? No se puede deshacer.`)) {
        await db.deleteLot(lot.id);
        afterChange();
        location.hash = '#/';
      }
    }
  });

  bindNoteCards();
}

function noteCard(n, media) {
  const chips = [
    n.phenology && `<span class="chip">${esc(n.phenology)}</span>`,
    n.pest && `<span class="chip warn">🐛 ${esc(n.pest)}</span>`,
    n.disease && `<span class="chip warn">🍂 ${esc(n.disease)}</span>`,
    n.weed && `<span class="chip warn">🌿 ${esc(n.weed)}</span>`,
    n.damage !== '' && n.damage != null && `<span class="chip dmg-${esc(n.damage)}">Daño: ${esc((DAMAGE.find((d) => d[0] === n.damage) || [])[1])}</span>`,
  ].filter(Boolean).join('');
  const photos = media.filter((m) => m.type === 'photo');
  const audios = media.filter((m) => m.type === 'audio');
  const videos = media.filter((m) => m.type === 'video');
  return `
    <article class="card" data-note="${n.id}">
      <header>
        <span>${visitLabel(n)}</span>
        <span class="muted">${esc(n.author)}${n.editedAt ? ` · editada${n.editedBy && n.editedBy !== n.author ? ` por ${esc(n.editedBy)}` : ''}` : ''}</span>
        ${canDelete(n) ? `<a class="link" href="#/nota/editar/${n.id}">Editar</a>` : ''}
        ${canDelete(n) ? `<button class="link danger" data-delete="${n.id}" aria-label="Borrar nota">Borrar</button>` : ''}
        ${n.dirty && sync.enabled ? '<span class="muted small" title="Falta sincronizar">⏳</span>' : ''}
      </header>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      ${n.text ? `<p class="text">${esc(n.text)}</p>` : ''}
      ${(n.actions || []).length ? `<div class="actions"><div class="small muted">Próximas acciones${n.due ? ` · para el ${fmtDay(n.due)}` : ''}</div>
        ${n.actions.map((a) => `<label class="action ${a.done ? 'done' : ''}"><input type="checkbox" data-action="${n.id}:${a.id}" ${a.done ? 'checked' : ''}> ${esc(a.text)}</label>`).join('')}</div>` : ''}
      ${photos.length ? `<div class="thumbs">${photos.map((m) => `<figure><img src="${mediaSrc(m)}"${remoteAttr(m)} alt="Foto" data-full loading="lazy">${m.lat != null ? '<span class="pin" title="Foto con ubicación">📍</span>' : ''}</figure>`).join('')}</div>` : ''}
      ${audios.map((m) => `<audio controls preload="metadata" src="${mediaSrc(m)}"${remoteAttr(m)}></audio>${mediaLoc(m)}${transcriptBlock(m)}`).join('')}
      ${videos.map((m) => `<video controls playsinline preload="metadata" src="${mediaSrc(m)}"${remoteAttr(m)}></video>${mediaLoc(m)}`).join('')}
      ${n.lat != null ? `<div class="muted small">📍 ${n.lat.toFixed(5)}, ${n.lng.toFixed(5)} (±${n.accuracy} m)</div>` : ''}
    </article>`;
}

// Archivo guardado en el dispositivo o, si todavía no se bajó, desde el servidor.
function mediaSrc(m) {
  return m.blob ? blobUrl(m.blob) : '';
}

function remoteAttr(m) {
  return m.blob ? '' : ` data-remote="${m.id}"`;
}

async function hydrateMedia() {
  for (const el of app.querySelectorAll('[data-remote]')) {
    const m = await db.get('media', el.dataset.remote);
    if (!m) continue;
    const url = m.blob ? blobUrl(m.blob) : await sync.mediaUrl(m);
    if (url) el.src = url;
  }
}

function transcriptBlock(m) {
  if (m.summary || m.transcript) {
    return `<div class="transcript">
      ${m.summary ? `<div class="summary">${esc(m.summary).replace(/\n/g, '<br>')}</div>` : ''}
      ${m.transcript ? `<details><summary>Ver transcripción completa</summary><p>${esc(m.transcript)}</p></details>` : ''}
    </div>`;
  }
  if (!sync.enabled) return '';
  return m.remote ? `<button class="link" data-transcribe="${m.id}">📝 Transcribir audio</button>` : '<div class="muted small">Se transcribe al sincronizar.</div>';
}

function mediaLoc(m) {
  return m.lat != null ? `<div class="muted small">📍 ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>` : '';
}

let currentProfile = null;
function canDelete(n) {
  return !sync.enabled || !currentProfile || currentProfile.role === 'admin' || !n.authorId || n.authorId === currentProfile.id;
}

function pendingBox(notes) {
  const items = notes.flatMap((n) => (n.actions || []).filter((a) => !a.done).map((a) => ({ n, a })));
  if (!items.length) return '';
  return `<section class="pending-box">
    <strong>Pendientes (${items.length})</strong>
    ${items.map(({ n, a }) => `<label class="action"><input type="checkbox" data-action="${n.id}:${a.id}"> ${esc(a.text)}
      <span class="muted small">${n.due ? `para el ${fmtDay(n.due)}` : `desde ${fmtDate(when(n), false)}`}${n.due && n.due < today() ? ' · <b class="late">vencido</b>' : ''}</span></label>`).join('')}
  </section>`;
}

// Fecha de la visita (las notas viejas no la tienen: se usa la de carga).
function when(n) {
  return n.visitAt || n.createdAt;
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function visitLabel(n) {
  if (sameDay(when(n), n.createdAt)) return fmtDate(n.createdAt);
  return `${fmtDate(when(n), false)} <span class="muted small">(cargada el ${fmtDate(n.createdAt, false)})</span>`;
}

function visitTimestamp(iso) {
  if (!iso || iso === today()) return Date.now();
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

function today() {
  return isoDay(Date.now());
}

function isoDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDay(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function bindNoteCards() {
  hydrateMedia();
  app.querySelectorAll('[data-transcribe]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.textContent = 'Transcribiendo…';
    btn.disabled = true;
    let res;
    try { res = await sync.requestTranscription(btn.dataset.transcribe); } catch (err) { res = { error: err.message || String(err) }; }
    if (res && res.transcript) render();
    else {
      btn.textContent = 'No se pudo transcribir. Reintentar';
      btn.disabled = false;
      btn.nextElementSibling?.classList.contains('transcribe-error') && btn.nextElementSibling.remove();
      btn.insertAdjacentHTML('afterend', `<div class="muted small transcribe-error">Error: ${esc((res && res.error) || (res ? `respuesta inesperada ${JSON.stringify(res).slice(0, 300)}` : 'sin respuesta'))}</div>`);
    }
  }));
  app.querySelectorAll('[data-action]').forEach((box) => box.addEventListener('change', async () => {
    const [noteId, actionId] = box.dataset.action.split(':');
    const note = await db.get('notes', noteId);
    const action = note && (note.actions || []).find((a) => a.id === actionId);
    if (!action) return;
    action.done = box.checked;
    action.doneAt = box.checked ? Date.now() : null;
    await db.save('notes', note);
    afterChange();
    render();
  }));
  app.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (confirm('¿Borrar esta nota? No se puede deshacer.')) {
      await db.deleteNote(btn.dataset.delete);
      afterChange();
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

// ---------- Nueva nota / editar nota ----------

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

async function viewEditNote(noteId) {
  const note = await db.get('notes', noteId);
  if (!note || note.deleted || !canDelete(note)) { location.hash = '#/'; return; }
  await viewNewNote(note.lotId, note);
}

async function viewNewNote(lotId, editing = null) {
  const lot = await db.get('lots', lotId);
  if (!lot || lot.deleted) { location.hash = '#/'; return; }
  const me = await author();
  const pending = []; // { type, blob, mime, lat, lng, accuracy, createdAt }
  // Al editar: archivos que ya tenía la nota, y los que se marcan para quitar.
  const existing = editing ? live(await db.byIndex('media', 'noteId', editing.id)).sort((a, b) => a.createdAt - b.createdAt) : [];
  const removed = new Set();
  const replaced = new Map(); // id de foto existente → foto editada
  let notePos = null;
  let recorder = null;
  const visitValue = editing ? isoDay(when(editing)) : today();
  const back = `#/lote/${lot.id}`;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="${back}" aria-label="Cancelar">‹</a>
      <h1>${editing ? 'Editar nota' : 'Nueva nota'} · ${esc(lot.name)}</h1>
    </header>
    <main class="page form">
      <div id="gps" class="muted small">${editing ? '' : '📍 Buscando ubicación…'}</div>
      <label>Fecha de la visita
        <input id="visit" type="date" value="${visitValue}" max="${today()}">
      </label>
      <label>Lo que viste
        <textarea id="text" rows="5" placeholder="Estado del cultivo, plagas, malezas, humedad…"></textarea>
      </label>
      <div class="grid3">
        <label>Cultivo
          <select id="crop">
            <option value="">Sin definir</option>
            ${Object.entries(CROPS).map(([k, c]) => `<option value="${k}" ${cropKey(lot.crop) === k ? 'selected' : ''}>${c.name}</option>`).join('')}
          </select>
        </label>
        <label><span>Estado fenológico <span id="scale" class="small"></span></span>
          <select id="phenology"></select>
        </label>
        <div class="field"><span>Plaga</span>
          <input id="pest" placeholder="Tocá o escribí la primera letra">
        </div>
        <div class="field"><span>Enfermedad</span>
          <input id="disease" placeholder="Tocá o escribí la primera letra">
        </div>
        <div class="field"><span>Maleza</span>
          <input id="weed" placeholder="Tocá o escribí la primera letra">
        </div>
        <label>Nivel de daño
          <select id="damage">${DAMAGE.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
        </label>
      </div>
      <label>Próximas acciones / a prestar atención (una por línea)
        <textarea id="actions" rows="3" placeholder="Aplicar insecticida en cabecera norte&#10;Volver a mirar chinche en 7 días"></textarea>
      </label>
      <label>Revisar para el
        <input id="due" type="date">
      </label>
      <div class="media-buttons">
        <label class="btn">📷 Foto<input id="photo" type="file" accept="image/*" multiple hidden></label>
        <label class="btn">🎥 Video<input id="video" type="file" accept="video/*" hidden></label>
        <button id="rec" class="btn">🎙️ Grabar audio</button>
      </div>
      <div id="existing" class="pending"></div>
      <div id="pending" class="pending"></div>
      <button id="save" class="btn primary">${editing ? 'Guardar cambios' : 'Guardar nota'}</button>
    </main>`;

  const cropOf = () => CROPS[document.getElementById('crop').value];
  const allOf = (field) => [...new Set(Object.values(CROPS).flatMap((c) => c[field]))];
  combo(document.getElementById('pest'), 'pests', () => (cropOf() ? cropOf().pests : allOf('pests')));
  combo(document.getElementById('disease'), 'diseases', () => (cropOf() ? cropOf().diseases : allOf('diseases')));
  combo(document.getElementById('weed'), 'weeds', () => WEEDS);

  function fillCropLists() {
    const crop = CROPS[document.getElementById('crop').value];
    document.getElementById('scale').textContent = crop ? `(${crop.scale})` : '';
    document.getElementById('phenology').innerHTML = '<option value="">—</option>' +
      (crop ? crop.phenology.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('') : '');
  }
  if (editing) {
    const $ = (id) => document.getElementById(id);
    $('text').value = editing.text || '';
    $('crop').value = editing.crop || '';
    $('pest').value = editing.pest || '';
    $('disease').value = editing.disease || '';
    $('weed').value = editing.weed || '';
    $('damage').value = editing.damage || '';
    $('actions').value = (editing.actions || []).map((a) => a.text).join('\n');
    $('due').value = editing.due || '';
  }
  fillCropLists();
  if (editing && editing.phenology) {
    const sel = document.getElementById('phenology');
    if (![...sel.options].some((o) => o.value === editing.phenology)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(editing.phenology)}">${esc(editing.phenology)}</option>`);
    sel.value = editing.phenology;
  }
  document.getElementById('crop').addEventListener('change', fillCropLists);

  function renderExisting() {
    const el = document.getElementById('existing');
    el.innerHTML = existing.map((m) => `
      <div class="pending-item" style="${removed.has(m.id) ? 'opacity:.4' : ''}">
        ${m.type === 'photo' ? (replaced.has(m.id) ? `<img src="${blobUrl(replaced.get(m.id))}" alt="">` : `<img src="${mediaSrc(m)}"${remoteAttr(m)} alt="">`) : m.type === 'audio' ? `<audio controls src="${mediaSrc(m)}"${remoteAttr(m)}></audio>` : `<video src="${mediaSrc(m)}"${remoteAttr(m)} playsinline muted></video>`}
        <span class="muted small">${removed.has(m.id) ? 'Se va a quitar' : m.lat != null ? '📍 con ubicación' : ''}</span>
        ${m.type === 'photo' && !removed.has(m.id) ? `<button class="link" data-edit-ex="${m.id}">✏️ Editar</button>` : ''}
        <button class="link ${removed.has(m.id) ? '' : 'danger'}" data-ex="${m.id}">${removed.has(m.id) ? 'Deshacer' : 'Quitar'}</button>
      </div>`).join('');
    el.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.ex;
      if (removed.has(id)) removed.delete(id); else removed.add(id);
      renderExisting();
    }));
    el.querySelectorAll('[data-edit-ex]').forEach((b) => b.addEventListener('click', async () => {
      const m = existing.find((x) => x.id === b.dataset.editEx);
      let blob = replaced.get(m.id) || (await db.get('media', m.id))?.blob;
      if (!blob) {
        try { blob = await (await fetch(await sync.mediaUrl(m))).blob(); } catch { blob = null; }
      }
      if (!blob) return alert('Para editar esta foto necesitás conexión.');
      const out = await editPhoto(blob);
      if (out) { replaced.set(m.id, out); renderExisting(); }
    }));
    hydrateMedia();
  }
  renderExisting();

  const gpsEl = document.getElementById('gps');
  if (!editing) getPosition().then((pos) => {
    notePos = pos;
    if (!pos) { gpsEl.textContent = '📍 Sin ubicación (revisá los permisos de GPS)'; return; }
    const inside = containsPoint(lot.geometry, pos.lat, pos.lng);
    gpsEl.textContent = `📍 ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${pos.accuracy} m)${inside ? '' : ' · fuera del lote'}`;
  });

  const isToday = () => !document.getElementById('visit').value || document.getElementById('visit').value === today();
  document.getElementById('visit').addEventListener('change', () => renderPending());

  function renderPending() {
    const el = document.getElementById('pending');
    el.innerHTML = pending.map((m, i) => `
      <div class="pending-item">
        ${m.type === 'photo' ? `<img src="${blobUrl(m.blob)}" alt="">` : m.type === 'audio' ? `<audio controls src="${blobUrl(m.blob)}"></audio>` : `<video src="${blobUrl(m.blob)}" playsinline muted></video>`}
        <span class="muted small">${m.fileLoc ? '📍 ubicación del archivo' : m.liveLoc && isToday() ? '📍 GPS actual' : 'Sin ubicación'}</span>
        ${m.type === 'photo' ? `<button class="link" data-edit="${i}">✏️ Editar</button>` : ''}
        <button class="link danger" data-rm="${i}">Quitar</button>
      </div>`).join('');
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const m = pending[Number(b.dataset.edit)];
      const out = await editPhoto(m.blob);
      if (out) { m.blob = out; m.mime = out.type; renderPending(); }
    }));
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { pending.splice(Number(b.dataset.rm), 1); renderPending(); }));
  }

  // Cada archivo guarda su propia ubicación: la que trae adentro (foto o video
  // sacado antes) o, si no trae, la del GPS en el momento de agregarlo.
  async function addMedia(type, blob, meta) {
    const live = (await getPosition(8000)) || notePos;
    pending.push({
      type, blob, mime: blob.type,
      fileLoc: meta && meta.lat != null ? { lat: meta.lat, lng: meta.lng } : null,
      liveLoc: live,
      takenAt: meta && meta.takenAt ? meta.takenAt : null,
      createdAt: Date.now(),
    });
    renderPending();
  }

  document.getElementById('photo').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      const meta = await photoMeta(f); // antes de comprimir, que borra los metadatos
      await addMedia('photo', await compressImage(f), meta);
    }
    e.target.value = '';
  });

  document.getElementById('video').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) {
      if (f.size > 100 * 1024 * 1024) alert('El video es muy pesado (más de 100 MB). Probá con uno más corto.');
      else await addMedia('video', f, await videoMeta(f));
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
    if (editing) return saveEdit();
    const note = {
      id: db.uid(),
      lotId: lot.id,
      createdAt: Date.now(),
      visitAt: visitTimestamp(document.getElementById('visit').value),
      author: me,
      authorId: ((await sync.profile()) || {}).id || null,
      text: document.getElementById('text').value.trim(),
      phenology: document.getElementById('phenology').value.trim(),
      crop: document.getElementById('crop').value,
      pest: document.getElementById('pest').value.trim(),
      disease: document.getElementById('disease').value.trim(),
      weed: document.getElementById('weed').value.trim(),
      actions: document.getElementById('actions').value.split('\n').map((t) => t.trim()).filter(Boolean)
        .map((text) => ({ id: db.uid(), text, done: false })),
      due: document.getElementById('due').value,
      damage: document.getElementById('damage').value,
      lat: notePos ? notePos.lat : null,
      lng: notePos ? notePos.lng : null,
      accuracy: notePos ? notePos.accuracy : null,
    };
    if (!note.text && !note.phenology && !note.pest && !note.disease && !note.weed && !note.actions.length && !note.damage && !pending.length) return alert('La nota está vacía.');
    // Si la nota se carga otro día, la ubicación actual no es la de la visita.
    const sameDayVisit = document.getElementById('visit').value === today() || !document.getElementById('visit').value;
    if (!sameDayVisit) note.lat = note.lng = note.accuracy = null;
    for (const m of pending) {
      const loc = m.fileLoc || (sameDayVisit ? m.liveLoc : null);
      m.lat = loc ? loc.lat : null;
      m.lng = loc ? loc.lng : null;
      m.accuracy = loc && loc.accuracy != null ? loc.accuracy : null;
      m.locSource = m.fileLoc ? 'archivo' : loc ? 'gps' : null;
      delete m.fileLoc;
      delete m.liveLoc;
    }
    await db.save('notes', note);
    // Lo escrito a mano queda como opción para la próxima vez.
    await addCustomOption('pests', note.pest);
    await addCustomOption('diseases', note.disease);
    await addCustomOption('weeds', note.weed);
    if (note.crop && cropKey(lot.crop) !== note.crop && (await sync.isAdmin())) { lot.crop = note.crop; await db.save('lots', lot); }
    for (const m of pending) await db.save('media', { id: db.uid(), noteId: note.id, lotId: lot.id, ...m });
    afterChange();
    toast('Nota guardada');
    location.hash = `#/lote/${lot.id}`;
  });

  async function saveEdit() {
    const note = (await db.get('notes', editing.id)) || editing;
    const visit = document.getElementById('visit').value;
    // Las acciones que ya existían conservan si estaban hechas.
    const previous = note.actions || [];
    const actions = document.getElementById('actions').value.split('\n').map((t) => t.trim()).filter(Boolean)
      .map((text) => previous.find((a) => a.text === text) || { id: db.uid(), text, done: false });
    Object.assign(note, {
      visitAt: visit && visit !== visitValue ? visitTimestamp(visit) : note.visitAt,
      text: document.getElementById('text').value.trim(),
      phenology: document.getElementById('phenology').value.trim(),
      crop: document.getElementById('crop').value,
      pest: document.getElementById('pest').value.trim(),
      disease: document.getElementById('disease').value.trim(),
      weed: document.getElementById('weed').value.trim(),
      actions,
      due: document.getElementById('due').value,
      damage: document.getElementById('damage').value,
      editedAt: Date.now(),
      editedBy: me,
    });
    const keeps = existing.filter((m) => !removed.has(m.id)).length;
    if (!note.text && !note.phenology && !note.pest && !note.disease && !note.weed && !note.actions.length && !note.damage && !keeps && !pending.length) {
      return alert('La nota quedaría vacía. Si no la querés, usá Borrar.');
    }
    await db.save('notes', note);
    await addCustomOption('pests', note.pest);
    await addCustomOption('diseases', note.disease);
    await addCustomOption('weeds', note.weed);
    for (const id of removed) {
      const m = await db.get('media', id);
      if (m) { m.deleted = true; m.blob = null; await db.save('media', m); }
    }
    // Una foto editada se guarda como archivo nuevo (con la misma ubicación) y reemplaza a la original.
    for (const [id, blob] of replaced) {
      if (removed.has(id)) continue;
      const old = await db.get('media', id);
      if (!old) continue;
      const { id: _id, path, remote, dirty, rev, deleted, ...meta } = old;
      await db.save('media', { ...meta, id: db.uid(), blob, mime: blob.type, edited: true });
      old.deleted = true;
      old.blob = null;
      await db.save('media', old);
    }
    const sameDayVisit = !visit || visit === today();
    for (const m of pending) {
      const loc = m.fileLoc || (sameDayVisit ? m.liveLoc : null);
      m.lat = loc ? loc.lat : null;
      m.lng = loc ? loc.lng : null;
      m.accuracy = loc && loc.accuracy != null ? loc.accuracy : null;
      m.locSource = m.fileLoc ? 'archivo' : loc ? 'gps' : null;
      delete m.fileLoc;
      delete m.liveLoc;
      await db.save('media', { id: db.uid(), noteId: note.id, lotId: lot.id, ...m });
    }
    afterChange();
    toast('Cambios guardados');
    location.hash = back;
  }
}

// ---------- Ingreso ----------

async function viewLogin() {
  let mode = 'login';
  function draw(error = '') {
    app.innerHTML = `
      <header class="bar"><h1>Recorridas</h1></header>
      <main class="page form login">
        <img class="login-logo" src="icons/logo.png" alt="Las Nazarenas">
        <p>${mode === 'login' ? 'Iniciá sesión para sincronizar tus recorridas.' : 'Creá tu cuenta. El primero en registrarse queda como administrador.'}</p>
        ${mode === 'signup' ? '<label>Tu nombre<input id="name" autocomplete="name"></label>' : ''}
        <label>Mail<input id="email" type="email" autocomplete="email" inputmode="email"></label>
        <label>Contraseña<input id="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
        ${error ? `<p class="late">${esc(error)}</p>` : ''}
        <button id="go" class="btn primary">${mode === 'login' ? 'Entrar' : 'Crear cuenta'}</button>
        <button id="switch" class="link">${mode === 'login' ? '¿No tenés cuenta? Crear una' : 'Ya tengo cuenta'}</button>
      </main>`;
    document.getElementById('switch').addEventListener('click', () => { mode = mode === 'login' ? 'signup' : 'login'; draw(); });
    document.getElementById('go').addEventListener('click', async (e) => {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const nameEl = document.getElementById('name');
      if (!email || !password || (nameEl && !nameEl.value.trim())) return draw('Completá todos los campos.');
      e.target.disabled = true;
      e.target.textContent = 'Un momento…';
      try {
        if (mode === 'login') await sync.signIn(email, password);
        else await sync.signUp(email, password, nameEl.value.trim());
        currentProfile = await sync.profile();
        location.hash = '#/';
        render();
        runSync();
      } catch (err) {
        draw(err.message || String(err));
      }
    });
  }
  draw();
}

// ---------- Ajustes ----------

async function viewSettings() {
  const name = await db.getSetting('author', '');
  const { campaign } = await currentCampaign();
  const profile = await sync.profile();
  const admin = await sync.isAdmin();
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1048576).toFixed(1)} MB usados`;
  }
  const lastSync = await db.getSetting('lastSync');

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
      ${sync.enabled && profile ? `
        <section class="box">
          <strong>Cuenta</strong>
          <div class="muted">${esc(profile.email)} · ${profile.role === 'admin' ? 'Administrador' : 'Usuario'}</div>
          <div id="sync-state" class="muted"></div>
          <div class="muted small">Última sincronización: ${lastSync ? fmtDate(lastSync) : 'nunca'}</div>
          <div class="row">
            <button id="sync-now" class="btn grow">🔄 Sincronizar ahora</button>
            <button id="logout" class="btn grow">Cerrar sesión</button>
          </div>
        </section>
        <section class="box" id="push">
          <strong>Avisos</strong>
          ${sync.pushSupported() ? `
            <label class="action"><input id="push-on" type="checkbox"> Avisarme cuando alguien cargue una nota</label>
            <div class="muted small">Te llega un aviso en este dispositivo cuando otro usuario carga una nota en un lote que vos ves.</div>
            <button id="push-test" class="btn" hidden>Probar aviso</button>
            <div id="push-msg" class="muted small"></div>` : `
            <div class="muted small">${/iPhone|iPad/.test(navigator.userAgent)
              ? 'Para recibir avisos en el iPhone, abrí la app desde el ícono de la pantalla de inicio (no desde Safari). Necesita iOS 16.4 o más nuevo.'
              : 'Este navegador no permite avisos.'}</div>`}
        </section>
        ${admin ? `<section class="box" id="users"><strong>Usuarios y lotes que ve cada uno</strong><div class="muted">Cargando…</div></section>` : ''}
      ` : '<p class="muted">Las notas se guardan solo en este dispositivo.</p>'}
      <p class="muted">Almacenamiento: ${usage || 'sin datos'}.</p>
      ${campaign && admin ? `<button id="del-campaign" class="btn danger">Borrar campaña “${esc(campaign.name)}”</button>` : ''}
      <p class="muted small">Versión ${APP_VERSION}</p>
    </main>`;

  document.getElementById('save-author').addEventListener('click', async () => {
    const value = document.getElementById('author').value.trim() || 'Sin nombre';
    try { await sync.updateName(value); toast('Guardado'); } catch { toast('Guardado en el dispositivo; se actualiza al tener señal'); }
  });
  const del = document.getElementById('del-campaign');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`¿Borrar la campaña “${campaign.name}” con todos sus lotes y notas? No se puede deshacer.`)) return;
    await db.deleteCampaign(campaign.id);
    afterChange();
    location.hash = '#/';
  });

  if (!(sync.enabled && profile)) return;
  const stateEl = document.getElementById('sync-state');
  const off = sync.onStatus((st) => { if (document.body.contains(stateEl)) stateEl.textContent = statusText(st); else off(); });
  document.getElementById('sync-now').addEventListener('click', () => runSync(true));
  document.getElementById('logout').addEventListener('click', async () => {
    const pending = await db.pendingCount();
    const msg = pending
      ? `Hay ${pending} cambios sin sincronizar que se van a perder. ¿Cerrar sesión igual?`
      : '¿Cerrar sesión? Se borran los datos de este dispositivo (quedan guardados en la nube).';
    if (!confirm(msg)) return;
    await sync.signOut();
    currentProfile = null;
    location.hash = '#/';
    render();
  });
  if (admin) renderUsers(campaign);
  bindPush();
}

async function bindPush() {
  const box = document.getElementById('push-on');
  if (!box) return;
  const test = document.getElementById('push-test');
  const msg = document.getElementById('push-msg');
  const on = await sync.pushEnabled();
  box.checked = on;
  test.hidden = !on;
  box.addEventListener('change', async () => {
    box.disabled = true;
    msg.textContent = box.checked ? 'Activando…' : 'Desactivando…';
    try {
      if (box.checked) { await sync.enablePush(); msg.textContent = 'Avisos activados en este dispositivo.'; }
      else { await sync.disablePush(); msg.textContent = 'Avisos desactivados.'; }
    } catch (err) {
      box.checked = !box.checked;
      msg.textContent = `No se pudo: ${err.message || err}`;
    }
    test.hidden = !box.checked;
    box.disabled = false;
  });
  test.addEventListener('click', async () => {
    msg.textContent = 'Enviando…';
    try {
      const r = await sync.testPush();
      msg.textContent = r.sent ? 'Aviso enviado. Debería llegarte en unos segundos.' : 'No se pudo enviar el aviso. Probá desactivar y volver a activar.';
    } catch (err) {
      msg.textContent = `No se pudo: ${err.message || err}`;
    }
  });
}

async function renderUsers(campaign) {
  const box = document.getElementById('users');
  const lots = await lotsOf(campaign && campaign.id);
  let data;
  try {
    data = await sync.listUsers();
  } catch {
    box.innerHTML = '<strong>Usuarios</strong><div class="muted">Se necesita señal para ver y cambiar los permisos.</div>';
    return;
  }
  const { users, access } = data;
  const has = (u, l) => access.some((a) => a.user_id === u && a.lot_id === l);
  box.innerHTML = `
    <strong>Usuarios y lotes que ve cada uno</strong>
    <div class="muted small">Campaña ${esc(campaign ? campaign.name : '—')}. Para sumar a alguien, que abra la app y se cree una cuenta; después aparece acá.</div>
    ${users.map((u) => `
      <details class="user">
        <summary><strong>${esc(u.name || u.email)}</strong> <span class="muted small">${esc(u.email)} · ${u.role === 'admin' ? 'Administrador (ve todo)' : `${lots.filter((l) => has(u.id, l.id)).length} de ${lots.length} lotes`}</span></summary>
        ${u.id === currentProfile.id ? '' : `<label class="action"><input type="checkbox" data-role="${u.id}" ${u.role === 'admin' ? 'checked' : ''}> Administrador</label>`}
        ${u.role === 'admin' ? '' : `
          <label class="action"><input type="checkbox" data-all="${u.id}" ${lots.length && lots.every((l) => has(u.id, l.id)) ? 'checked' : ''}> <b>Todos los lotes</b></label>
          ${lots.map((l) => `<label class="action"><input type="checkbox" data-user="${u.id}" data-lot="${l.id}" ${has(u.id, l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('')}`}
      </details>`).join('')}`;

  const refresh = async (fn) => {
    try { await fn(); toast('Permisos actualizados'); } catch (err) { toast(`No se pudo: ${err.message}`); }
    const open = [...box.querySelectorAll('details[open] summary')].map((s) => s.textContent);
    await renderUsers(campaign);
    box.querySelectorAll('details summary').forEach((s) => { if (open.includes(s.textContent)) s.parentElement.open = true; });
  };
  box.querySelectorAll('[data-lot]').forEach((cb) => cb.addEventListener('change', () =>
    refresh(() => sync.setAccess(cb.dataset.user, [cb.dataset.lot], cb.checked))));
  box.querySelectorAll('[data-all]').forEach((cb) => cb.addEventListener('change', () =>
    refresh(() => sync.setAccess(cb.dataset.all, lots.map((l) => l.id), cb.checked))));
  box.querySelectorAll('[data-role]').forEach((cb) => cb.addEventListener('change', () => {
    if (!confirm(cb.checked ? '¿Hacerlo administrador? Va a ver y poder cambiar todo.' : '¿Quitarle el rol de administrador?')) { cb.checked = !cb.checked; return; }
    refresh(() => sync.setRole(cb.dataset.role, cb.checked ? 'admin' : 'user'));
  }));
}

// ---------- Sincronización ----------

function statusText(st) {
  if (st.state === 'syncing') return '🔄 Sincronizando…';
  if (st.state === 'offline') return `📴 Sin señal${st.pending ? ` · ${st.pending} cambios para subir` : ''}`;
  if (st.state === 'error') return `⚠️ ${st.error}${st.pending ? ` · ${st.pending} cambios para subir` : ''}`;
  if (st.state === 'ok') return st.pending ? `☁️ ${st.pending} cambios para subir` : '☁️ Todo sincronizado';
  return '';
}

function bindSyncBadge() {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  const off = sync.onStatus((st) => {
    if (!document.body.contains(el)) { off(); return; }
    el.textContent = { syncing: '🔄', offline: '📴', error: '⚠️', ok: st.pending ? `☁️${st.pending}` : '☁️✓', idle: '☁️' }[st.state];
    el.title = statusText(st);
  });
}

let syncTimer = null;
// Después de cada cambio se sincroniza a los pocos segundos.
function afterChange() {
  if (!sync.enabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), 2000);
}

async function runSync(manual = false) {
  if (!sync.enabled || !currentProfile) return;
  const { changed } = await sync.syncNow();
  if (manual) toast(statusText(await new Promise((r) => sync.onStatus((st) => r(st))())) || 'Listo');
  // Si llegaron datos nuevos, se redibuja salvo que esté cargando una nota.
  if (changed && !location.hash.startsWith('#/nota/')) render();
}

// ---------- Router ----------

async function render() {
  cleanup();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (sync.enabled && !currentProfile) await viewLogin();
    else if (parts[0] === 'lote' && parts[1]) await viewLot(parts[1]);
    else if (parts[0] === 'nota' && parts[1] === 'nueva' && parts[2]) await viewNewNote(parts[2]);
    else if (parts[0] === 'nota' && parts[1] === 'editar' && parts[2]) await viewEditNote(parts[2]);
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
(async () => {
  currentProfile = await sync.profile();
  await render();
  runSync();
})();

window.addEventListener('online', () => runSync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 3 * 60 * 1000);

if ('serviceWorker' in navigator) {
  // Cuando hay una versión nueva publicada, la toma sola (sin perder una nota a medio escribir).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (location.hash.startsWith('#/nota/')) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
