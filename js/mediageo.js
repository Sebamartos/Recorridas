// Lee la ubicación y la fecha guardadas dentro de fotos (EXIF) y videos (metadatos
// de QuickTime/MP4), para respetar dónde se sacó cada archivo.

// ---------- Fotos (JPEG con EXIF) ----------

export async function photoMeta(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch { /* archivo sin EXIF legible */ }
  return null;
}

function parseTiff(v, start) {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
  const ifd = (o) => {
    const tags = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return tags;
  };
  const rational = (o) => u32(o) / (u32(o + 4) || 1);
  const ascii = (t) => {
    const at = t.count > 4 ? u32(t.at) : t.at;
    let s = '';
    for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(start + at + i));
    return s;
  };

  const ifd0 = ifd(u32(4));
  const out = {};

  if (ifd0[0x8769]) {
    const exif = ifd(u32(ifd0[0x8769].at));
    const dt = exif[0x9003] || exif[0x9004];
    if (dt) {
      const m = ascii(dt).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (m) out.takenAt = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
  }

  if (ifd0[0x8825]) {
    const gps = ifd(u32(ifd0[0x8825].at));
    const coord = (tag, refTag) => {
      if (!gps[tag] || !gps[refTag]) return null;
      const o = u32(gps[tag].at);
      const val = rational(o) + rational(o + 8) / 60 + rational(o + 16) / 3600;
      const ref = String.fromCharCode(v.getUint8(start + gps[refTag].at));
      return ref === 'S' || ref === 'W' ? -val : val;
    };
    const lat = coord(2, 1);
    const lng = coord(4, 3);
    if (lat != null && lng != null && (lat || lng)) Object.assign(out, { lat, lng });
  }
  return out.lat != null || out.takenAt ? out : null;
}

// ---------- Videos (MOV/MP4) ----------

// iPhone y Android guardan la ubicación como texto ISO 6709, ej: "-37.8341-058.2557+120.000/".
export async function videoMeta(file) {
  const CHUNK = 1024 * 1024;
  const parts = [file.slice(0, CHUNK)];
  if (file.size > CHUNK) parts.push(file.slice(Math.max(CHUNK, file.size - 4 * CHUNK)));
  for (const part of parts) {
    const text = new TextDecoder('latin1').decode(await part.arrayBuffer());
    for (const key of ['location.ISO6709', '©xyz']) {
      let idx = text.indexOf(key);
      while (idx !== -1) {
        const m = text.slice(idx, idx + 400).match(/([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
        if (m) {
          const lat = parseFloat(m[1]);
          const lng = parseFloat(m[2]);
          if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) return { lat, lng };
        }
        idx = text.indexOf(key, idx + 1);
      }
    }
  }
  return null;
}
