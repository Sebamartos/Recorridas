// Función de Supabase: avisos (notificaciones) cuando alguien carga una nota.
// Se crea en Supabase → Edge Functions con el nombre "notify" (Verify JWT apagado).
// No necesita secretos: las claves de los avisos se crean solas la primera vez
// y quedan guardadas en la tabla push_config, que solo puede leer el servidor.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const URL_BASE = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_URL = 'https://sebamartos.github.io/Recorridas/';
const service = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ---------- Base de datos (API REST con la clave del servidor) ----------

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...service, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Web Push (RFC 8291 + VAPID), solo con WebCrypto ----------

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// Cifra el mensaje para un dispositivo (Content-Encoding: aes128gcm).
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string) {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// Encabezado de identificación del servidor (VAPID, firma ES256).
export async function vapidHeader(endpoint: string, publicKey: string, privateJwk: JsonWebKey) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${publicKey}`;
}

async function vapidKeys() {
  const rows = await rest('push_config?id=eq.1&select=public_key,private_jwk');
  if (rows?.length) return { publicKey: rows[0].public_key as string, privateJwk: rows[0].private_jwk as JsonWebKey };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  // Si otro pedido las creó al mismo tiempo, quedan las primeras.
  await rest('push_config', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify({ id: 1, public_key: publicKey, private_jwk: privateJwk }) });
  return vapidKeys();
}

type Sub = { endpoint: string; p256dh: string; auth: string };

async function sendTo(subs: Sub[], message: unknown) {
  const { publicKey, privateJwk } = await vapidKeys();
  const payload = enc.encode(JSON.stringify(message));
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidHeader(s.endpoint, publicKey, privateJwk),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'normal',
        },
        body: await encryptPayload(payload, s.p256dh, s.auth),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) sent++;
      else {
        console.warn('aviso rechazado', res.status, (await res.text()).slice(0, 200));
        // El dispositivo ya no existe (se desinstaló la app o se quitó el permiso).
        if (res.status === 404 || res.status === 410) await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' });
      }
    } catch (err) {
      console.warn('aviso falló', String(err));
    }
  }));
  return sent;
}

// ---------- Pedidos de la app ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json();
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const userRes = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!userRes || !userRes.ok) return json({ error: 'Sesión inválida, volvé a iniciar sesión' }, 401);
    const user = await userRes.json();

    if (body.action === 'key') return json({ publicKey: (await vapidKeys()).publicKey });

    if (body.action === 'subscribe') {
      const s = body.subscription;
      if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: 'Suscripción inválida' }, 400);
      await rest('push_subscriptions', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ endpoint: s.endpoint, user_id: user.id, p256dh: s.keys.p256dh, auth: s.keys.auth }),
      });
      return json({ ok: true });
    }

    if (body.action === 'unsubscribe') {
      await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint ?? '')}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return json({ ok: true });
    }

    if (body.action === 'test') {
      const subs = await rest(`push_subscriptions?user_id=eq.${user.id}&select=endpoint,p256dh,auth`);
      const sent = await sendTo(subs, { title: 'Recorridas', body: 'Los avisos funcionan ✔', url: APP_URL });
      return json({ sent, devices: subs.length });
    }

    if (body.action === 'note') {
      const id = encodeURIComponent(body.note_id ?? '');
      const note = (await rest(`notes?id=eq.${id}&select=id,lot_id,author_id,data,deleted`))?.[0];
      if (!note || note.deleted || note.author_id !== user.id) return json({ sent: 0 });
      // Cada nota avisa una sola vez.
      const fresh = await rest('push_sent', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ note_id: note.id }) });
      if (!fresh?.length) return json({ sent: 0 });

      const lot = (await rest(`lots?id=eq.${encodeURIComponent(note.lot_id)}&select=name`))?.[0];
      const admins = await rest('profiles?role=eq.admin&select=id');
      const access = await rest(`lot_access?lot_id=eq.${encodeURIComponent(note.lot_id)}&select=user_id`);
      const users = new Set<string>([...admins.map((r: { id: string }) => r.id), ...access.map((r: { user_id: string }) => r.user_id)]);
      users.delete(user.id);
      if (!users.size) return json({ sent: 0 });
      const subs = await rest(`push_subscriptions?user_id=in.(${[...users].join(',')})&select=endpoint,p256dh,auth`);
      const d = note.data ?? {};
      const what = [d.text, d.pest && `Plaga: ${d.pest}`, d.disease && `Enfermedad: ${d.disease}`, d.weed && `Maleza: ${d.weed}`].filter(Boolean).join(' · ');
      const sent = await sendTo(subs, {
        title: `Nueva nota · ${lot?.name ?? 'lote'}`,
        body: `${d.author || 'Alguien'}: ${(what || 'con fotos o audio').slice(0, 140)}`,
        url: `${APP_URL}#/lote/${note.lot_id}`,
      });
      return json({ sent });
    }

    return json({ error: 'Pedido desconocido' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
