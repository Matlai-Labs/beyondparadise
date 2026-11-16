#!/usr/bin/env node
// The owner's content rules, as one pure function in front of every path to the queue and every publish.
// rulesGate(text, { neverPromotePatterns, claims }) -> { ok, violations: [{ rule, match }] }. Deterministic, no I/O.
// Rules (ids): sea-conditions, seaweed-farming-place, first-person-visit, never-promote (+ never-promote-list-unavailable),
// paid-link-wording, unsourced-figure. Wording/taste (hype) is NOT here: the voice linter covers it.
// The never-promote list is private (~/.matlai/bpa-never-promote.json, BPA_NEVER_PROMOTE_FILE overrides): it is never
// copied into the repository, never printed, and a violation names the pattern's INDEX, not its text.
// Fail closed: a missing, unreadable, empty or malformed list refuses every text.
// CLI: node rules-gate.js --check-queue [queue.json]   (read-only; counts per state, ids + rule ids of what would be refused)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── rule 1 + 2: sea conditions, seaweed farming (constants moved here from ideas.js; ideas.js re-exports them) ──
/** Sea-condition observations are never proposed. Whole-word, case-insensitive. */
export const REFUSAL_PATTERNS = {
  seaweed: /\bseaweeds?\b/i,
  seaState: /\bsea[- ]states?\b/i,
  waves: /\bwaves?\b/i,
  swimming: /\bswimming\b/i,
  swimConditions: /\bswim(?:ming)? conditions?\b/i,
  washedUp: /\bwash(?:ed|es|ing)[- ](?:up|ashore)\b/i,
};
// "Seaweed farming in Paje, Jambiani and parts of Bwejuu" is a fact about those places, not a sea observation.
export const SEAWEED_FARMING = /\bseaweed\s+(?:farm(?:ing|s|ers?)?|harvest(?:ing|s|ers?)?)\b|\b(?:farm(?:ing|s|ed)?|harvest(?:ing|s|ed)?)\s+(?:of\s+)?seaweed\b/i;
export const SEAWEED_OK_PLACE = /\b(?:Paje|Jambiani|Bwejuu)\b/, SEAWEED_BAD_PLACE = /\b(?:Michamvi|Pingwe|Kae)\b/;
/** Refusal hit names for a text. A seaweed FARMING mention in an allowed place and no forbidden place is not a sea observation. */
export function refusalHits(text) {
  const t = String(text || '');
  const hits = Object.entries(REFUSAL_PATTERNS).filter(([, re]) => re.test(t)).map(([n]) => n);
  if (hits.includes('seaweed') && SEAWEED_FARMING.test(t) && SEAWEED_OK_PLACE.test(t) && !SEAWEED_BAD_PLACE.test(t)) hits.splice(hits.indexOf('seaweed'), 1);
  return hits;
}

// ── rule 3: first person about having been somewhere ──
export const FIRST_PERSON_PATTERNS = [
  /\b(?:we|i)\s+(?:stayed|visited|tried|went|saw|ate|dived|snorkell?ed|slept|tested|booked|spent|walked|swam|toured|drove|flew|took|loved|enjoyed)\b/i,
  /\b(?:we|i)(?:['’]ve|\s+have)\s+(?:been|stayed|visited|tried|seen)\b/i,
  /\b(?:our|my)\s+(?:visit|stay|trip|tour|experience|night|nights)\b/i,
  /\b(?:we|i)\s+(?:were|was)\s+(?:at|in|there|staying)\b/i,
];

// ── rule 5: wording that sells or implies a paid link ──
export const PAID_LINK_PATTERNS = [
  /\bbook\s+now\b/i, /\bbook\s+with\s+us\b/i, /\blink\s+in\s+(?:our\s+|my\s+|the\s+)?bio\s+to\s+book\b/i, /\buse\s+our\s+link\b/i,
  /\bdiscount\s+codes?\b/i, /\baffiliates?\b/i, /\bsponsored\b/i, /\bpartner\s+offers?\b/i, /\b(?:dm|message)\s+us\s+to\s+book\b/i,
];

// ── rule 6: money figures must come from a dated claim ──
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const FIGURE_RES = [
  new RegExp(String.raw`(?:\b(?:USD|TZS|TSh|EUR)\b|US\$|\$|€)\s?(${NUM})`, 'gi'),
  new RegExp(String.raw`(?<![\d.,])(${NUM})\s?(?:\b(?:USD|TZS|TSh|EUR|dollars?|shillings?|euros?)\b|\$|€)`, 'gi'),
  new RegExp(String.raw`\b(?:fees?|charges?|prices?|costs?)\b[^\d.\n]{0,15}?(${NUM})`, 'gi'),
  new RegExp(String.raw`(?<![\d.,])(${NUM})\s?(?:fee|charge|price)\b`, 'gi'),
];
const toNumber = (s) => Number(String(s).replace(/,/g, ''));
const isYear = (s) => /^(?:19|20)\d\d$/.test(s);
function figuresIn(text) {
  const out = []; const seen = new Set();
  for (const re of FIGURE_RES) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const n = m[1]; const word = /^\s*(?:fees?|charges?|prices?|costs?)/i.test(m[0]) || /(?:fee|charge|price)$/i.test(m[0]);
      if (word && isYear(n)) continue; // "price list 2026": a year, not an amount
      const key = `${m.index}:${toNumber(n)}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ value: toNumber(n), shown: m[0].trim() });
    }
  }
  return out;
}
function sourcedValues(claims) {
  const set = new Set();
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string' || typeof c.sourceDate !== 'string' || !c.sourceDate.trim()) continue;
    for (const m of c.text.matchAll(new RegExp(NUM, 'g'))) set.add(toNumber(m[0]));
  }
  return set;
}

// ── rule 4: the private never-promote list ──
const WORDCHAR = String.raw`[\p{L}\p{N}_]`;
/** Literal, case-insensitive, whole-word (spaces in a pattern match any run of whitespace). Regex characters are not code. */
export function compileNeverPattern(p) {
  const esc = String(p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`);
  return new RegExp(`(?<!${WORDCHAR})${esc}(?!${WORDCHAR})`, 'iu');
}
export const neverPromoteFile = (env = process.env) => env.BPA_NEVER_PROMOTE_FILE || path.join(os.homedir(), '.matlai', 'bpa-never-promote.json');
/** { ok:true, patterns } or { ok:false, reason }. The reason names the path and the kind of problem, never any file content. */
export function loadNeverPromote({ env = process.env, file = neverPromoteFile(env) } = {}) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: `never-promote list unreadable at ${file} (${e.code || 'error'})` }; }
  let j; try { j = JSON.parse(raw); } catch { return { ok: false, reason: `never-promote list at ${file} is not valid JSON` }; }
  const list = j && !Array.isArray(j) ? j.patterns : null;
  if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.trim())) return { ok: false, reason: `never-promote list at ${file} must be { "patterns": [non-empty strings] } with at least one entry` };
  return { ok: true, patterns: list.map((p) => p.trim()) };
}
const usableList = (l) => Array.isArray(l) && l.length > 0 && l.every((p) => typeof p === 'string' && p.trim());

export function rulesGate(text, { neverPromotePatterns, claims } = {}) {
  const t = typeof text === 'string' ? text : (text == null || typeof text === 'object' ? '' : String(text));
  const violations = []; const add = (rule, match = '') => violations.push({ rule, match });
  // 1 sea-conditions (a seaweed FARMING mention is judged by rule 2 instead)
  const farming = SEAWEED_FARMING.test(t);
  for (const [name, re] of Object.entries(REFUSAL_PATTERNS)) { if (name === 'seaweed' && farming) continue; const m = re.exec(t); if (m) add('sea-conditions', m[0]); }
  // 2 seaweed-farming-place
  if (farming && !(SEAWEED_OK_PLACE.test(t) && !SEAWEED_BAD_PLACE.test(t))) add('seaweed-farming-place', SEAWEED_FARMING.exec(t)[0]);
  // 3 first-person-visit
  for (const re of FIRST_PERSON_PATTERNS) { const m = re.exec(t); if (m) { add('first-person-visit', m[0]); break; } }
  // 4 never-promote (fail closed)
  if (!usableList(neverPromotePatterns)) add('never-promote-list-unavailable');
  else neverPromotePatterns.forEach((p, i) => { try { if (compileNeverPattern(p).test(t)) add('never-promote', `#${i}`); } catch { add('never-promote-list-unavailable', `#${i}`); } });
  // 5 paid-link-wording
  for (const re of PAID_LINK_PATTERNS) { const m = re.exec(t); if (m) add('paid-link-wording', m[0]); }
  // 6 unsourced-figure
  const ok = sourcedValues(claims);
  for (const f of figuresIn(t)) if (!ok.has(f.value)) add('unsourced-figure', f.shown);
  return { ok: violations.length === 0, violations };
}

// ── CLI: read-only look at a queue file ──
async function checkQueue(file) {
  let q; try { q = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`rules-gate: cannot read ${file} (${e.code || e.message})`); return 2; }
  const drafts = Array.isArray(q?.drafts) ? q.drafts : [];
  const { finalCheck } = await import('./lib.js'); // dynamic: lib.js imports this file
  const counts = {}; for (const d of drafts) counts[d.status] = (counts[d.status] || 0) + 1;
  console.log(`queue: ${file}`); console.log(`items: ${drafts.length}; per state: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  const open = drafts.filter((d) => d.status !== 'posted' && d.status !== 'skipped' && d.status !== 'expired');
  let refused = 0;
  for (const d of open) {
    const c = await finalCheck(d);
    if (!c.ok) { refused++; console.log(`${d.id} [${d.status}] would be refused: ${c.ruleIds.join(', ')}`); }
  }
  console.log(`not yet posted: ${open.length}; would be refused: ${refused}`);
  return 0;
}
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2);
  // no top-level await: lib.js imports this file, so this module must finish evaluating before checkQueue's dynamic import of lib.js
  if (a[0] === '--check-queue') checkQueue(path.resolve(a[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'queue.json'))).then((code) => { process.exitCode = code; }, (e) => { console.error(`rules-gate: ${e.message}`); process.exitCode = 2; });
  else { console.error('usage: node rules-gate.js --check-queue [path/to/queue.json]'); process.exitCode = 2; }
}
