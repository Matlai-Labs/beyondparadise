// Everything the social pipeline reaches for OUTSIDE this repo, in one place:
// filesystem paths on Tim's Mac, another project's credential file, the render's animation asset,
// and the Graph API transport. Addresses 2026-11 audit findings 5, 6 and 12 — each was previously
// a literal pasted at the point of use, so none could be redirected, tested or audited.
//
// Rules here: every path is overridable by a NAMED env var, defaults are exactly what the code
// used before (Tim's Mac keeps working unchanged), and a miss fails with a message that says which
// env var to set instead of a bare ENOENT from somewhere deep in a publish run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Decode a module URL to a filesystem path. `new URL(u).pathname` stays percent-encoded, so a
 *  directory containing a space resolves to a path that does not exist (Node docs call that wrong). */
export function modulePath(metaUrl) { return fileURLToPath(metaUrl); }

export const HERE = path.dirname(modulePath(import.meta.url));

const AI_PROJECTS = '/Users/tim/Desktop/AI_projects';

/** name → { env, default, what }. `what` is the human half of the error message. */
export const RESOURCES = {
  voiceLint: {
    env: 'VOICE_LINT_PATH',
    default: `${AI_PROJECTS}/shared_knowledge/scripts/voice-lint/voice-lint.mjs`,
    what: 'the shared voice-lint module (the voice gate fails closed without it)',
  },
  metaPublish: {
    env: 'META_PUBLISH_PATH',
    default: `${AI_PROJECTS}/shared_knowledge/scripts/meta-pages/publish.js`,
    what: 'the meta-pages publish module (Facebook/Instagram posting)',
  },
  metaTokens: {
    env: 'META_TOKENS_PATH',
    default: path.join(os.homedir(), '.config', 'meta-pages', 'tokens.json'),
    what: 'the meta-pages token store (read only to check granted scopes)',
  },
  // NOTE (audit finding 6, open): this is another brand's WordPress credential file, and BPA media
  // is still uploaded to that brand's domain. Where BPA media should live is Tim's decision; making
  // the location configurable is all this round does.
  mediaEnv: {
    env: 'BPA_MEDIA_ENV_FILE',
    default: `${AI_PROJECTS}/Padel_Revive/.env`,
    what: 'the .env holding the WP_* credentials used to host rendered cards and reels',
  },
};

export function resourcePath(name, env = process.env) {
  const r = RESOURCES[name];
  if (!r) throw new Error(`unknown external resource "${name}" (known: ${Object.keys(RESOURCES).join(', ')})`);
  return env[r.env] || r.default;
}

/** Resolve an external path and prove it is there, or explain exactly how to point us at it. */
export function requireResource(name, env = process.env) {
  const p = resourcePath(name, env);
  if (!fs.existsSync(p)) throw new Error(`cannot find ${RESOURCES[name].what}: nothing at ${p}. Set ${RESOURCES[name].env} to its location.`);
  return p;
}

/** The reel animation library, served from node_modules instead of a CDN: a changed or compromised
 *  CDN asset must not be able to run inside the headless Chrome that renders Tim's reels, and an
 *  offline render has to work. Pinned in package.json/package-lock.json (gsap 3.12.5). */
export function gsapAssetPath(env = process.env) {
  const candidates = env.BPA_GSAP_PATH
    ? [env.BPA_GSAP_PATH]
    : [path.join(HERE, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), path.join(HERE, '..', 'node_modules', 'gsap', 'dist', 'gsap.min.js')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`gsap.min.js not found (looked at: ${candidates.join(', ')}). Run "npm install" in social/, or set BPA_GSAP_PATH.`);
}

/** The three brand faces the reel uses, served from node_modules (@fontsource ships the upstream
 *  Google Fonts binaries) instead of fonts.googleapis.com. A render then needs no network at all,
 *  and it looks the same offline as online — with the webfont missing, the fallback stack is thinner
 *  and more of each frame is near-black, which pushes the reel past the reel-qa black-share gate. */
const FONT_FACES = [
  { as: 'playfair-700-italic.woff2', pkg: '@fontsource/playfair-display', file: 'playfair-display-latin-700-italic.woff2', family: 'Playfair Display', weight: 700, style: 'italic' },
  { as: 'inter-400.woff2', pkg: '@fontsource/inter', file: 'inter-latin-400-normal.woff2', family: 'Inter', weight: 400, style: 'normal' },
  { as: 'inter-600.woff2', pkg: '@fontsource/inter', file: 'inter-latin-600-normal.woff2', family: 'Inter', weight: 600, style: 'normal' },
];

export function fontAssets() {
  return FONT_FACES.map((f) => {
    const candidates = [path.join(HERE, 'node_modules', f.pkg, 'files', f.file), path.join(HERE, '..', 'node_modules', f.pkg, 'files', f.file)];
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) throw new Error(`font ${f.as} not found (looked at: ${candidates.join(', ')}). Run "npm install" in social/.`);
    return { ...f, path: found };
  });
}

// ── Graph API transport (audit finding 12) ───────────────────────────────────
// A token in a URL query string is written into every proxy, access and error log on the way.
// POSTs already carry it in the body; the polling GETs did not. One helper builds them all so a
// future call site cannot quietly go back to pasting `access_token=` into a template literal.
//
// Default stays the query-string form: Meta's Graph API is widely reported to accept
// `Authorization: Bearer`, but that could not be confirmed against Meta's own documentation or a
// live call from the cloud session that wrote this, and a wrong guess here breaks publishing.
// Set BPA_META_AUTH_HEADER=1 once a real Graph call is seen to succeed with the header.
export const GRAPH_VERSION = process.env.BPA_GRAPH_VERSION || 'v21.0';

export function graphRequestSpec(pathAndQuery, { token, method = 'GET', form = null, env = process.env } = {}) {
  const useHeader = env.BPA_META_AUTH_HEADER === '1';
  const [pth, rawQuery = ''] = String(pathAndQuery).split('?');
  const query = new URLSearchParams(rawQuery);
  const headers = {};
  let body;
  if (useHeader) headers.Authorization = `Bearer ${token}`;
  if (form) {
    const f = new URLSearchParams(form);
    if (!useHeader) f.set('access_token', token);
    body = f;
  } else if (!useHeader) {
    query.set('access_token', token);
  }
  const qs = query.toString();
  return { url: `https://graph.facebook.com/${GRAPH_VERSION}/${pth}${qs ? `?${qs}` : ''}`, method, headers, body };
}

/** Make a Graph API call and return the parsed JSON.
 *  `throwOnError: false` keeps the pre-existing tolerance of the container-status polls, which read
 *  `status_code` themselves and must not abort a publish on one bad reply. */
export async function graphCall(pathAndQuery, { token, method = 'GET', form = null, timeoutMs = 60000, throwOnError = true, env = process.env } = {}) {
  const spec = graphRequestSpec(pathAndQuery, { token, method, form, env });
  const r = await fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if (throwOnError && j?.error) throw new Error(`${String(pathAndQuery).split('?')[0]}: ${j.error.message}`);
  return j;
}
