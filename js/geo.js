// Lectura de KML/KMZ y utilidades geográficas.

// Extrae el primer .kml de un .kmz (zip) usando DecompressionStream.
async function kmzToText(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 30 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    let compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 30, nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    if (flags & 0x08 && compSize === 0) {
      // Tamaño en el directorio central: lo buscamos ahí.
      compSize = centralSize(view, buffer.byteLength, name);
    }
    const data = new Uint8Array(buffer, dataStart, compSize);
    if (name.toLowerCase().endsWith('.kml')) {
      if (method === 0) return new TextDecoder().decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    offset = dataStart + compSize;
  }
  throw new Error('El KMZ no contiene un archivo KML');
}

function centralSize(view, length, wanted) {
  for (let i = length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    let p = view.getUint32(i + 16, true);
    const count = view.getUint16(i + 10, true);
    for (let n = 0; n < count; n++) {
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const name = new TextDecoder().decode(new Uint8Array(view.buffer, p + 46, nameLen));
      if (name === wanted) return size;
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
  throw new Error('KMZ dañado');
}

// Devuelve [{ name, geometry }] con los polígonos del archivo.
export async function parseLotsFile(file) {
  const isKmz = file.name.toLowerCase().endsWith('.kmz');
  const text = isKmz ? await kmzToText(await file.arrayBuffer()) : await file.text();
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('No se pudo leer el KML');
  const geojson = window.toGeoJSON.kml(xml);
  const lots = [];
  geojson.features.forEach((f, i) => {
    const g = f.geometry && flatten(f.geometry);
    if (!g) return;
    const name = (f.properties && f.properties.name) || `Lote ${i + 1}`;
    lots.push({ name: String(name).trim(), geometry: g });
  });
  if (!lots.length) throw new Error('El archivo no tiene polígonos de lotes');
  return lots;
}

// Deja solo polígonos (Polygon o MultiPolygon) y descarta altitudes.
function flatten(geometry) {
  const strip = (ring) => ring.map((c) => [c[0], c[1]]);
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(strip) };
  }
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map(strip)) };
  }
  if (geometry.type === 'GeometryCollection') {
    const polys = geometry.geometries.map(flatten).filter(Boolean);
    if (!polys.length) return null;
    const coords = [];
    polys.forEach((p) => (p.type === 'Polygon' ? coords.push(p.coordinates) : coords.push(...p.coordinates)));
    return { type: 'MultiPolygon', coordinates: coords };
  }
  return null;
}

function polygons(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function containsPoint(geometry, lat, lng) {
  return polygons(geometry).some(
    (poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))
  );
}

// Superficie aproximada en hectáreas (proyección local equirectangular).
export function areaHa(geometry) {
  const R = 6371008.8;
  let total = 0;
  for (const poly of polygons(geometry)) {
    poly.forEach((ring, idx) => {
      const lat0 = (ring.reduce((s, c) => s + c[1], 0) / ring.length) * (Math.PI / 180);
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const x1 = ring[j][0] * (Math.PI / 180) * R * Math.cos(lat0);
        const y1 = ring[j][1] * (Math.PI / 180) * R;
        const x2 = ring[i][0] * (Math.PI / 180) * R * Math.cos(lat0);
        const y2 = ring[i][1] * (Math.PI / 180) * R;
        a += x1 * y2 - x2 * y1;
      }
      total += (idx === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total / 10000;
}

export function getPosition(timeout = 15000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}
