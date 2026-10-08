/** Replace HTML/Astro tags with spaces, keeping every offset (and newline) identical so line numbers survive. */
export function maskTags(text, { keepJsonLd = true } = {}) {
  const skipRe = keepJsonLd ? /<(script|style)\b(?![^>]*ld\+json)[\s\S]*?<\/\1>/gi : /<(script|style)\b[\s\S]*?<\/\1>/gi;
  return text
    .replace(skipRe, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<[^>\n]*>/g, (m) => ' '.repeat(m.length))
    .replace(/&nbsp;/g, '      ');
}

/** Split into sentences with 1-based line numbers. A newline is always a boundary (bullets, JSON values). */
export function splitSentences(text) {
  const out = [];
  const re = /[^\n]+/g; let m; let line = 1; let pos = 0;
  while ((m = re.exec(text))) {
    for (let i = text.indexOf('\n', pos); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
    pos = m.index;
    const parts = m[0].split(/(?<=[.!?])\s+(?=[\p{Lu}"'(“])|(?<=["}\]]),(?=\s*["{\[])/u);
    let off = 0;
    for (const part of parts) {
      const t = part.trim();
      if (t.length > 2) out.push({ text: t.replace(/\\"/g, '"').replace(/\\n/g, ' '), line });
      off += part.length;
    }
  }
  return out;
}

export const stripAccents = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Unicode-aware whole-word alternation. */
export function wordRe(words, flags = 'iu') {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, flags);
}
