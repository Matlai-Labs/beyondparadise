import fs from 'node:fs';
import path from 'node:path';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseHtml(html) {
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const lang = (html.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i) || [, ''])[1].toLowerCase();
  const robots = [...html.matchAll(/<meta[^>]+name=["']robots["'][^>]*>/gi)].map((m) => m[0]).join(' ');
  const noindex = /content=["'][^"']*noindex/i.test(robots);
  const refresh = /<meta[^>]+http-equiv=["']refresh["']/i.test(html);
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i) || [, ''])[1];
  const links = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)].map((m) => decode(m[1]));
  const h1 = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ''])[1]);
  const headings = [...html.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({ level: +m[1][1], text: strip(m[2]) }));
  const summaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gi)].map((m) => strip(m[1]));
  const ldBlocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const ldQuestions = [];
  const ldDates = [];
  for (const b of ldBlocks) {
    for (const m of b.matchAll(/"dateModified"\s*:\s*"([^"]+)"/g)) ldDates.push(m[1]);
    for (const m of b.matchAll(/"@type"\s*:\s*"Question"[^}]*?"name"\s*:\s*"([^"]+)"/g)) ldQuestions.push(m[1]);
  }
  const metaMod = (html.match(/<meta[^>]+(?:article:modified_time|og:updated_time)["'][^>]*content=["']([^"']+)["']/i) || [, ''])[1];
  if (metaMod) ldDates.push(metaMod);
  return { title, lang, noindex, refresh, canonical, links, h1, headings, summaries, ldQuestions, ldDates };
}

/** dist file -> site path: index.html -> dir, foo.html -> /foo */
export function fileToPath(root, file) {
  let rel = '/' + path.relative(root, file).split(path.sep).join('/');
  rel = rel.replace(/\.html?$/i, '').replace(/\/index$/, '');
  return rel === '' ? '/' : rel;
}

export function normalizePath(p) {
  p = p.replace(/[?#].*$/, '').replace(/\.html?$/i, '').replace(/\/index$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** Resolve an href found on `fromPath` to an internal site path, or null if external/non-page. */
export function resolveInternal(href, fromPath, origins = []) {
  href = href.trim();
  if (!href || /^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return null;
  let p;
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    let u; try { u = new URL(href.startsWith('//') ? 'https:' + href : href); } catch { return null; }
    if (!origins.some((o) => o === u.origin || o === u.host)) return null;
    p = u.pathname;
  } else if (href.startsWith('/')) p = href;
  else {
    // Relative link: resolve against the page's own path as a directory (Astro/index.html output, trailingSlash 'always').
    p = new URL(href.replace(/[?#].*$/, '') || '.', 'http://x' + (fromPath === '/' ? '/' : fromPath + '/')).pathname;
  }
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|pdf|xml|txt|json|woff2?|mp4|webm|zip)$/i.test(p.replace(/[?#].*$/, ''))) return null;
  return normalizePath(decodeURI(p));
}
export function readText(file) { return fs.readFileSync(file, 'utf8'); }
