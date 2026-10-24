// Función de Supabase: transcribe y resume un audio de recorrida con Gemini.
// Se crea en Supabase → Edge Functions con el nombre "transcribe".
// Necesita el secreto GEMINI_API_KEY (Edge Functions → Secrets).
import { createClient } from 'npm:@supabase/supabase-js@2.117.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
    const url = Deno.env.get('SUPABASE_URL')!;

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Quién llama, y si tiene acceso al lote del audio (admin o lote asignado).
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    if (!auth?.user) return json({ error: 'Sesión inválida' }, 401);
    const { data: media } = await admin.from('media').select('*').eq('id', media_id).single();
    if (!media || media.type !== 'audio') return json({ error: 'Audio no encontrado' }, 404);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', auth.user.id).single();
    const { data: access } = await admin.from('lot_access').select('lot_id').eq('user_id', auth.user.id).eq('lot_id', media.lot_id);
    if (profile?.role !== 'admin' && !access?.length) return json({ error: 'Sin acceso a este lote' }, 403);
    if (media.transcript) return json({ transcript: media.transcript, summary: media.summary });

    const { data: file, error: dlError } = await admin.storage.from('media').download(media.path);
    if (dlError || !file) return json({ error: 'No se pudo leer el audio' }, 500);

    const { data: note } = await admin.from('notes').select('data').eq('id', media.note_id).single();
    const { data: lot } = await admin.from('lots').select('name, crop').eq('id', media.lot_id).single();
    const context = [lot?.name && `Lote: ${lot.name}`, (note?.data?.crop || lot?.crop) && `Cultivo: ${note?.data?.crop || lot?.crop}`]
      .filter(Boolean).join('. ');

    const prompt = `Es un audio grabado por un ingeniero agrónomo recorriendo un lote en el sudeste de Buenos Aires, Argentina. ${context}
1) "transcript": transcribí el audio en español rioplatense, corrigiendo muletillas y repeticiones pero sin inventar nada.
2) "summary": resumen breve y práctico en viñetas cortas (cada una empezando con "• "): estado del cultivo, plagas/enfermedades/malezas observadas con su nivel, y acciones a realizar. Usá términos agronómicos correctos (estados fenológicos, nombres de plagas, productos). Si algo no se menciona, no lo agregues.`;

    const mime = (media.mime || 'audio/mp4').split(';')[0];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY')! },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mime, data: toBase64(new Uint8Array(await file.arrayBuffer())) } }, { text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { transcript: { type: 'STRING' }, summary: { type: 'STRING' } },
            required: ['transcript', 'summary'],
          },
        },
      }),
    });
    if (!res.ok) return json({ error: `Gemini: ${res.status} ${await res.text()}` }, 502);
    const out = await res.json();
    const text = out?.candidates?.[0]?.content?.parts?.[0]?.text;
    const { transcript, summary } = JSON.parse(text);

    await admin.from('media').update({ transcript, summary }).eq('id', media_id);
    return json({ transcript, summary });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
