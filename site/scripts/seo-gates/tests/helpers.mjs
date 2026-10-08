import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Build a throwaway site tree: makeSite({'index.html': '<html>…', 'a/index.html': '…'}) */
export function makeSite(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-gates-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export const page = (title, links = [], body = '', head = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${links
    .map((l) => `<a href="${l}">x</a>`)
    .join('')}${body}</body></html>`;
