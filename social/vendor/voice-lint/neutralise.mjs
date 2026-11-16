// Applies the recorded substitutions (neutralised.json) to the upstream text of a vendored file.
// Used by revendor.mjs (to write the copy) and by vendor-voice-lint.test.js (to prove the copy is
// current). The original wording is NOT stored in this public repository: a span is identified by
// its line range plus the SHA-256 of the original text (the lines joined with "\n", no trailing
// newline). If the upstream text in that range no longer hashes to the recorded value, the upstream
// note changed and a person must look at it before re-vendoring.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export class UpstreamNoteChanged extends Error {}

/** entries: [{ startLine, endLine, original_sha256, replacement }] — 1-based, inclusive, non-overlapping. */
export function applyNeutralisation(upstreamText, entries, label = 'file') {
  const lines = upstreamText.split('\n');
  for (const e of [...entries].sort((a, b) => b.startLine - a.startLine)) {
    const span = lines.slice(e.startLine - 1, e.endLine).join('\n');
    if (sha256(span) !== e.original_sha256) {
      throw new UpstreamNoteChanged(`${label}: the upstream note at lines ${e.startLine}-${e.endLine} changed (its SHA-256 no longer matches neutralised.json); the upstream note changed, re-vendor: read the new wording, reword it for a public repository, update neutralised.json, then run revendor.mjs`);
    }
    lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.replacement.split('\n'));
  }
  return lines.join('\n');
}
