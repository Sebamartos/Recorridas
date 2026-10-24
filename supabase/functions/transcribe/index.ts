// Función de Supabase: transcribe y resume un audio de recorrida con Gemini.
// Se crea en Supabase → Edge Functions con el nombre "transcribe".
// Necesita el secreto GEMINI_API_KEY (Edge Functions → Secrets).
// No usa librerías externas para que arranque rápido y gaste poco.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const URL_BASE = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

class StepError extends Error {}

// Cada paso tiene un tiempo máximo, así si algo se traba sabemos cuál fue.
async function step(name: string, url: string, init: RequestInit, seconds = 20) {
  console.log('paso:', name);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(seconds * 1000) });
  } catch (err) {
    throw new StepError(`${name}: ${err instanceof DOMException && err.name === 'TimeoutError' ? `no respondió en ${seconds} s` : String(err)}`);
  }
  if (!res.ok) throw new StepError(`${name}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

const service = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function selectOne(table: string, query: string) {
  const res = await step(`leer ${table}`, `${URL_BASE}/rest/v1/${table}?${query}`, { headers: service });
  const rows = await res.json();
  return rows[0] ?? null;
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { media_id } = await req.json();
    const id = encodeURIComponent(media_id);

    // Quién llama, y si tiene acceso al lote del audio (admin o lote asignado).
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const userRes = await fetch(`${URL_BASE}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!userRes || !userRes.ok) return json({ error: 'Sesión inválida, volvé a iniciar sesión' }, 401);
    const user = await userRes.json();

    const media = await selectOne('media', `id=eq.${id}&select=*`);
    if (!media || media.type !== 'audio') return json({ error: 'Audio no encontrado' }, 404);
    const profile = await selectOne('profiles', `id=eq.${user.id}&select=role`);
    const access = await selectOne('lot_access', `user_id=eq.${user.id}&lot_id=eq.${encodeURIComponent(media.lot_id)}&select=lot_id`);
    if (profile?.role !== 'admin' && !access) return json({ error: 'Sin acceso a este lote' }, 403);
    if (media.transcript) return json({ transcript: media.transcript, summary: media.summary });

    const fileRes = await step('bajar el audio', `${URL_BASE}/storage/v1/object/media/${media.path}`, { headers: service }, 30);
    const audio = new Uint8Array(await fileRes.arrayBuffer());
    console.log('audio:', audio.length, 'bytes', media.mime);

    const note = await selectOne('notes', `id=eq.${encodeURIComponent(media.note_id)}&select=data`);
    const lot = await selectOne('lots', `id=eq.${encodeURIComponent(media.lot_id)}&select=name,crop`);
    const crop = note?.data?.crop || lot?.crop;
    const context = [lot?.name && `Lote: ${lot.name}`, crop && `Cultivo: ${crop}`].filter(Boolean).join('. ');

    const prompt = `Es un audio grabado por un ingeniero agrónomo recorriendo un lote en el sudeste de Buenos Aires, Argentina. ${context}
1) "transcript": transcribí el audio en español rioplatense, corrigiendo muletillas y repeticiones pero sin inventar nada.
2) "summary": resumen breve y práctico en viñetas cortas (cada una empezando con "• "): estado del cultivo, plagas/enfermedades/malezas observadas con su nivel, y acciones a realizar. Usá términos agronómicos correctos (estados fenológicos, nombres de plagas, productos). Si algo no se menciona, no lo agregues.`;

    const mime = (media.mime || 'audio/mp4').split(';')[0];
    const geminiRes = await step('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY') ?? '' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mime, data: toBase64(audio) } }, { text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { transcript: { type: 'STRING' }, summary: { type: 'STRING' } },
            required: ['transcript', 'summary'],
          },
        },
      }),
    }, 90);
    const out = await geminiRes.json();
    const text = out?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return json({ error: `Gemini no devolvió texto: ${JSON.stringify(out).slice(0, 300)}` }, 502);
    const { transcript, summary } = JSON.parse(text);

    await step('guardar', `${URL_BASE}/rest/v1/media?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...service, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ transcript, summary }),
    });
    return json({ transcript, summary });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof StepError ? err.message : String(err) }, 500);
  }
});
