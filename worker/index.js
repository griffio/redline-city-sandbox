// Redline City on Cloudflare: static assets (dist/) plus this Worker for /api/*.
// Workers AI is reached through the AI binding, so no API token ships with the deploy.
// The endpoints mirror server.mjs so the client works the same against either.

const IMAGE_MODEL = '@cf/black-forest-labs/flux-2-dev'; // klein variants false-flag most car prompts
const TTS_MODEL = '@cf/deepgram/aura-2-en';
const MAX_IMAGE_B64 = 4_000_000; // the 512×1024 reference PNG is ~0.3–1 MB
const MAX_PROMPT = 2000;
// FLUX.2 [dev] bills per 512×512 tile per step (18.75 neurons in + 37.5 out). At 512×1024 (2 tiles)
// a step is ~112 neurons, so 12 steps ≈ 1,350 per image: ~7 images from the Free plan's 10,000/day.
// (25 steps was ~2,800 per image, only 3 a day.)
const IMAGE_STEPS = 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/health') return json({ ok: true });
      if (url.pathname === '/api/voice' && request.method === 'GET') return await voice(request, env, url);
      if (url.pathname === '/api/detail-car' && request.method === 'POST') return await detailCar(request, env, url);
      return json({ error: 'unknown endpoint' }, 404);
    } catch (err) {
      const msg = String(err?.message || err);
      console.error(`${request.method} ${url.pathname} failed: ${msg}`); // shows up in Workers Logs
      // Daily Workers AI allowance spent (Free plan: 10,000 neurons/day). 3036 is the documented
      // "Account limited" code; 4006 is what the binding actually returns, and it's widely reported to
      // keep firing after the 00:00 UTC reset while the dashboard still shows 0/10k neurons used.
      const quota = msg.match(/\b(3036|4006)\b/);
      if (quota) {
        return json({ error: "Today's free Workers AI allowance is used up. It resets at 00:00 UTC.", code: quota[1], detail: msg }, 429);
      }
      return json({ error: msg }, 500);
    }
  },
};

/** Software-rendered car sprite + prompt → FLUX.2 detailed/decaled image (as a data: URL). */
async function detailCar(request, env, url) {
  // Browsers always send Origin on a POST: only accept calls from the game's own pages.
  if (request.headers.get('origin') !== url.origin) return json({ error: 'forbidden' }, 403);
  if (Number(request.headers.get('content-length') || 0) > MAX_IMAGE_B64 + 10_000) return json({ error: 'too large' }, 413);

  const body = await request.json();
  const prompt = String(body.prompt || '').slice(0, MAX_PROMPT);
  const image = String(body.image || '');
  if (!prompt || !image || image.length > MAX_IMAGE_B64) return json({ error: 'prompt and image required' }, 400);

  // Budget check last, so a malformed request doesn't spend one of the visitor's 3 tokens a minute.
  const limited = await rateLimited(request, env);
  if (limited) return limited;

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', '512'); // fixed: the client clips the result to this frame
  form.append('height', '1024');
  form.append('steps', String(IMAGE_STEPS));
  if (Number.isInteger(body.seed)) form.append('seed', String(body.seed));
  form.append('input_image_0', new Blob([base64ToBytes(image)], { type: 'image/png' }), 'car.png');
  const multipart = new Response(form);
  const out = await env.AI.run(IMAGE_MODEL, {
    multipart: { body: multipart.body, contentType: multipart.headers.get('content-type') },
  });
  if (!out?.image) throw new Error('the image model returned no image');
  const type = out.image.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  // No storage needed: the client keeps the result (localStorage) and clips it to the sprite.
  return json({ url: `data:${type};base64,${out.image}` });
}

/** Announcer line: pre-generated lines are static assets; anything else goes to Aura TTS. */
async function voice(request, env, url) {
  const text = (url.searchParams.get('text') || '').slice(0, 200);
  const speaker = url.searchParams.get('speaker') || 'orion';
  if (!text) return json({ error: 'text required' }, 400);
  // same naming as the dev server's assets/voice cache
  const hash = (await sha1Hex(`${speaker}:${text}`)).slice(0, 16);
  const cached = await env.ASSETS.fetch(new URL(`/assets/voice/${hash}.mp3`, url));
  if (cached.ok) return audio(cached.body);

  const limited = await rateLimited(request, env);
  if (limited) return limited;
  const out = await env.AI.run(TTS_MODEL, { text, speaker });
  // the binding may hand back a stream, raw bytes, a Response or base64 depending on runtime version
  if (out instanceof Response) return audio(out.body);
  if (out instanceof ReadableStream || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return audio(out);
  if (typeof out?.audio === 'string') return audio(base64ToBytes(out.audio));
  throw new Error('the speech model returned no audio');
}

/**
 * Paid AI calls: a per-visitor budget plus a site-wide one, so one visitor can't drain the daily allowance.
 * Every call here spends a token, whether or not the AI call then succeeds, so call it only once the
 * request is known to be valid. Limits are approximate: counted per machine, synced per location.
 */
async function rateLimited(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  for (const [limiter, key] of [[env.AI_LIMIT_IP, ip], [env.AI_LIMIT_SITE, 'site']]) {
    if (limiter && !(await limiter.limit({ key })).success) {
      return json({ error: 'Too many AI requests right now, try again in a minute' }, 429);
    }
  }
  return null;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const audio = (body) => new Response(body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400' } });

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha1Hex(s) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
