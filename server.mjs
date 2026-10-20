// Redline City dev server.
// Serves the static game and proxies Cloudflare Workers AI so the API token never reaches the browser.
//   node server.mjs            -> http://localhost:5173
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 5173);
// Localhost only by default: the /api routes spend the Cloudflare account's quota. HOST=0.0.0.0 to share on a LAN.
const HOST = process.env.HOST || '127.0.0.1';

// --- env ---------------------------------------------------------------------
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
// .env names: CLOUDFLARE_API_KEY holds the account id, the token var is spelt COULDFLARE_API_TOKEN.
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_API_KEY;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.COULDFLARE_API_TOKEN;
const IMAGE_MODEL = '@cf/black-forest-labs/flux-2-dev'; // klein variants false-flag most car prompts
const TTS_MODEL = '@cf/deepgram/aura-2-en';

const cfUrl = (model) => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`;

// steps mirrors IMAGE_STEPS in worker/index.js: ~1,350 neurons per 512×1024 image, ~7 a day on the Free plan.
async function cfImage({ prompt, image, width = 512, height = 1024, steps = 12, seed }) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(width));
  form.append('height', String(height));
  form.append('steps', String(steps));
  if (seed != null) form.append('seed', String(seed));
  if (image) form.append('input_image_0', new Blob([image], { type: 'image/png' }), 'input.png');
  const res = await fetch(cfUrl(IMAGE_MODEL), {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
    body: form,
  });
  const json = await res.json();
  if (!json.success || !json.result?.image) {
    throw new Error(json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`);
  }
  return Buffer.from(json.result.image, 'base64');
}

async function cfSpeech(text, speaker = 'orion') {
  const res = await fetch(cfUrl(TTS_MODEL), {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, speaker }),
  });
  if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio/')) {
    throw new Error(`TTS failed: HTTP ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --- http ----------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.wgsl': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function readBody(req, limit = 20e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Paid AI endpoints: a small sliding-window budget so a stuck loop can't burn the quota.
const AI_LIMIT = { windowMs: 60_000, max: 20 };
const aiCalls = [];
function overBudget() {
  const now = Date.now();
  while (aiCalls.length && now - aiCalls[0] > AI_LIMIT.windowMs) aiCalls.shift();
  if (aiCalls.length >= AI_LIMIT.max) return true;
  aiCalls.push(now);
  return false;
}

async function handleApi(req, res, url) {
  if (!CF_ACCOUNT || !CF_TOKEN) return send(res, 500, { error: 'Cloudflare credentials missing from .env' });
  if (url.pathname === '/api/health') return send(res, 200, { ok: true });
  const cachedVoice = url.pathname === '/api/voice'; // cache hits are free; checked again below
  if (!cachedVoice && overBudget()) return send(res, 429, { error: 'AI request budget exceeded, try again in a minute' });

  // POST /api/detail-car  body: {prompt, image: <base64 png>}  -> image/jpeg
  // Runs the software-rendered sprite through FLUX.2 as a reference image and saves the result.
  if (url.pathname === '/api/detail-car' && req.method === 'POST') {
    const { prompt, image, width, height, seed } = JSON.parse((await readBody(req)).toString());
    const out = await cfImage({ prompt, image: Buffer.from(image, 'base64'), width, height, seed });
    const dir = path.join(ROOT, 'assets', 'generated');
    await fs.mkdir(dir, { recursive: true });
    const name = `car-${Date.now()}.jpg`;
    await fs.writeFile(path.join(dir, name), out);
    await fs.writeFile(path.join(dir, 'car-latest.jpg'), out);
    return send(res, 200, { url: `assets/generated/${name}` }); // relative: works under a subpath too
  }

  // POST /api/image {prompt, width, height} -> generated texture saved under assets/generated
  if (url.pathname === '/api/image' && req.method === 'POST') {
    const { prompt, width, height, seed } = JSON.parse((await readBody(req)).toString());
    const out = await cfImage({ prompt, width, height, seed });
    const dir = path.join(ROOT, 'assets', 'generated');
    await fs.mkdir(dir, { recursive: true });
    const name = `img-${Date.now()}.jpg`;
    await fs.writeFile(path.join(dir, name), out);
    return send(res, 200, { url: `/assets/generated/${name}` });
  }

  // GET /api/voice?text=... -> cached mp3 announcer line
  if (url.pathname === '/api/voice' && req.method === 'GET') {
    const text = (url.searchParams.get('text') || '').slice(0, 200);
    const speaker = url.searchParams.get('speaker') || 'orion';
    if (!text) return send(res, 400, { error: 'text required' });
    const hash = crypto.createHash('sha1').update(`${speaker}:${text}`).digest('hex').slice(0, 16);
    const dir = path.join(ROOT, 'assets', 'voice');
    const file = path.join(dir, `${hash}.mp3`);
    if (!existsSync(file)) {
      if (overBudget()) return send(res, 429, { error: 'AI request budget exceeded, try again in a minute' });
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, await cfSpeech(text, speaker));
    }
    return send(res, 200, await fs.readFile(file), 'audio/mpeg');
  }

  send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    // fixed base: the Host header is client-controlled and a malformed one must not throw out of the handler
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    const inside = file.startsWith(ROOT + path.sep);
    const hidden = path.relative(ROOT, file).split(path.sep).some((seg) => seg.startsWith('.')); // .env, .git/…
    if (!inside || hidden) return send(res, 403, 'forbidden', 'text/plain');
    const data = await fs.readFile(file);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return send(res, 404, 'not found', 'text/plain');
    if (err instanceof URIError || err instanceof TypeError) return send(res, 400, 'bad request', 'text/plain');
    console.error(err);
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => console.log(`Redline City → http://localhost:${PORT}` + (HOST === '127.0.0.1' ? '' : ` (listening on ${HOST})`)));
