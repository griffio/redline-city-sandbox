// The AI endpoints exist on the dev server (npm start) and the Cloudflare Worker deploy; plain
// static hosting (GitHub Pages) has none, so features ask once before calling them.
let probe = null;

export function aiAvailable() {
  if (location.hostname.endsWith('.github.io')) return Promise.resolve(false); // skip a guaranteed 404
  return (probe ??= fetch('api/health').then((r) => r.ok).catch(() => false));
}
