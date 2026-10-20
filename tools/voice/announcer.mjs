#!/usr/bin/env node
// Build-time announcer generator: ElevenLabs text-to-speech → assets/announcer/<slug>.mp3
//
// ElevenLabs is only ever called from here. The game just plays the committed files, so no key
// and no TTS service exist at runtime (and the announcer works on plain static hosting).
//
//   ELEVENLABS_API_KEY=sk_... node tools/voice/announcer.mjs                 # every line in lines.json
//   node tools/voice/announcer.mjs --only insane-drift,wrecked --takes 3 --out /tmp/takes
//
// Options
//   --voice <id>     ElevenLabs voice id (default: lines.json)
//   --model <id>     model id, e.g. eleven_v3 / eleven_multilingual_v2 (default: lines.json)
//   --takes <n>      generate n takes per line as <slug>-<n>.mp3 (default 1 → <slug>.mp3)
//   --out <dir>      output directory (default assets/announcer)
//   --only <slugs>   comma-separated slugs to (re)generate
//   --seed <n>       request a seed (best-effort determinism); takes use seed+n
//   --raw            keep ElevenLabs' output as-is (skip the trim + loudness pass)
//   --prompt <text>  override the prompt for every selected line (for trials)
//
// The key comes from ELEVENLABS_API_KEY in the environment or .env; it is never written anywhere.
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');

// --- args ------------------------------------------------------------------------
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  if (key === 'raw') args.raw = true;
  else args[key] = argv[++i];
}

const config = JSON.parse(readFileSync(path.join(HERE, 'lines.json'), 'utf8'));
const voice = args.voice || config.voice.id;
const model = args.model || config.model;
const settings = config.settings[model] || config.settings.default || {};
const takes = Math.max(1, Number(args.takes || 1));
const out = path.resolve(args.out || path.join(ROOT, 'assets', 'announcer'));
const only = args.only ? new Set(args.only.split(',')) : null;
const seed = args.seed != null ? Number(args.seed) : null;

// Same rule as Audio.slug in src/audio.js: "Nice drift!" → nice-drift
export const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- key ------------------------------------------------------------------------------
function envKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\n]+)/m);
  return m ? m[1].trim() : null;
}
const KEY = envKey();
if (!KEY) {
  console.error('ELEVENLABS_API_KEY is not set (environment or .env)');
  process.exit(1);
}

// --- ElevenLabs ------------------------------------------------------------------------
async function tts(text, requestSeed) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;
  const body = { text, model_id: model, voice_settings: settings };
  if (requestSeed != null) body.seed = requestSeed;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${await res.text()}`);
  return { audio: Buffer.from(await res.arrayBuffer()), requestId: res.headers.get('request-id') };
}

// --- post-processing -----------------------------------------------------------------
// Trim the leading silence so a callout lands the instant it fires, keep a short tail, then
// normalise loudness so every line sits at the same level in the mix (two-pass loudnorm).
const TRIM = [
  'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.02',
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.12',
  'afade=t=in:d=0.02', // (reversed) fade-out so the cut tail never clicks
  'areverse',
  'afade=t=in:d=0.005',
].join(',');
const TARGET = 'I=-16:TP=-1.5:LRA=9';

async function master(rawFile, outFile) {
  const { stderr } = await run('ffmpeg', ['-v', 'info', '-i', rawFile, '-af', `${TRIM},loudnorm=${TARGET}:print_format=json`, '-f', 'null', '-']);
  const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{')));
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', rawFile, '-af', `${TRIM},loudnorm=${TARGET}:${measured}`, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', outFile]);
  return { input_lufs: Number(m.input_i), input_tp: Number(m.input_tp) };
}

// --- main ----------------------------------------------------------------------------
await fs.mkdir(path.join(out, 'raw'), { recursive: true });
const manifestFile = path.join(out, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};

for (const [text, configuredPrompt] of Object.entries(config.lines)) {
  const s = slug(text);
  if (only && !only.has(s)) continue;
  const prompt = args.prompt || configuredPrompt;
  for (let take = 1; take <= takes; take++) {
    const name = takes > 1 ? `${s}-${take}` : s;
    const requestSeed = seed != null ? seed + take - 1 : null;
    process.stdout.write(`${name.padEnd(18)} ${JSON.stringify(prompt)} … `);
    const { audio, requestId } = await tts(prompt, requestSeed);
    const rawFile = path.join(out, 'raw', `${name}.mp3`);
    await fs.writeFile(rawFile, audio);
    const entry = { text, prompt, voice, model, settings, seed: requestSeed, request_id: requestId, file: `${name}.mp3` };
    if (args.raw) {
      await fs.copyFile(rawFile, path.join(out, `${name}.mp3`));
    } else {
      Object.assign(entry, await master(rawFile, path.join(out, `${name}.mp3`)));
    }
    manifest[name] = entry;
    console.log(`ok (${(audio.length / 1024).toFixed(0)} KB${entry.input_lufs != null ? `, ${entry.input_lufs.toFixed(1)} LUFS in` : ''})`);
  }
}
await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
const shown = path.relative(ROOT, out);
console.log(`→ ${shown.startsWith('..') ? out : shown || '.'}/ (${Object.keys(manifest).length} files in manifest)`);
