// Robust JSON extraction from model output.
//
// WHY THIS EXISTS (incident 2026-09-14): both `verify.ts` and `synthesize.ts`
// called `JSON.parse(res.text)` directly. Live models routinely wrap JSON in
// markdown fences (```json ... ```) or add a sentence around it, so every parse
// threw. `verify.ts` failed closed and held EVERY signal with the reason
// "unparseable verifier response" — two live runs published 0 signals while the
// brief said "we say nothing rather than say something wrong", which read like
// the precision design working correctly. It was a parsing bug.
//
// This extractor is deliberately permissive about PACKAGING (fences, prose,
// trailing text) and strict about CONTENT: if no JSON object can be recovered it
// returns null and the caller still fails closed. Packaging is the model's
// formatting habit; content is the thing we must not guess at.

/** Recover a JSON object from model output. Returns null when none can be found. */
export function parseJsonLoose(text) {
  if (typeof text !== "string" || text.trim() === "") return null;

  const candidates = [];
  const trimmed = text.trim();
  candidates.push(trimmed);

  // ```json ... ``` or ``` ... ``` (possibly with prose around it)
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());

  // First balanced {...} block — survives prose before/after, ignores braces
  // inside strings so a `reason` containing "{" cannot truncate the object.
  const block = firstJsonObject(trimmed);
  if (block) candidates.push(block);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Scan for the first complete top-level {...}, string-aware. */
function firstJsonObject(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
