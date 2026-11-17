// Post ideas -> checked drafts for the weekly draft job (B5). Used by draft.js only when config.ideaDrafts === true (off by default).
//   loadIdeaPool({ root, queuePath, now, env }) -> { ok, ideas, dropped, sourceNames } | { ok:false, reason }   reads the real inputs, writes nothing
//   draftIdeas({ config, queue, ask, ... })     -> drafts in the shape buildDrafts returns (gated), for the SAME queue path
// Fail closed: the private never-promote list must load (rules-gate.js loader) or there is no pool and no model call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdeaPool, loadInputs } from './ideas.js';
import { loadNeverPromote } from './rules-gate.js';
import { draftFromIdea } from './caption.js';
import { planCarousel } from './carousel.js';
import { CONFIG, QUEUE_PATH, brandGuard, sourceGate, voiceGate, rulesCheck } from './lib.js';
import { scoreDraft } from './score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const DEFAULT_PER_RUN = 3;
/** Used when config.captionModel is absent. */
export const DEFAULT_CAPTION_MODEL = 'hermes3:8b';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** factId -> "Source A and Source B" from data/facts/sources.json (best effort: an unknown source id is simply not named). */
function factSourceNames(root, facts) {
  const names = (readJson(path.join(root, 'data', 'facts', 'sources.json')) || {}).sources || {}; const out = {};
  for (const f of facts) { const n = (f.sources || []).map((s) => names[s]?.name).filter(Boolean).slice(0, 2); if (n.length) out[f.id] = n.join(' and '); }
  return out;
}

export function loadIdeaPool({ root = ROOT, queuePath = QUEUE_PATH, now = new Date(), env = process.env } = {}) {
  const never = loadNeverPromote({ env }); if (!never.ok) return { ok: false, reason: never.reason };
  let inp; try { inp = loadInputs({ root, queueFile: queuePath }); } catch (e) { return { ok: false, reason: `cannot read the idea inputs: ${e.message}` }; }
  const { ideas, dropped } = buildIdeaPool({ facts: inp.facts, pages: inp.pages, rules: inp.rules, history: inp.history, now, config: { ...inp.config, neverPromotePatterns: never.patterns } });
  return { ok: true, ideas, dropped, sourceNames: factSourceNames(root, Array.isArray(inp.facts) ? inp.facts : []) };
}

/** The same checks buildDrafts applies to every draft (brand, source, voice, rules with the claims), then createdAt and the advisory score. */
export async function gateIdeaDrafts(list, { now = new Date(), neverPromotePatterns } = {}) {
  const out = [];
  for (const g of list) {
    const bad = brandGuard(g.text) || sourceGate(g); if (bad) { out.push({ ...g, rejected: bad }); continue; }
    const v = await voiceGate(g.text); if (!v.ok) { out.push({ ...g, rejected: 'voice-lint: ' + v.reason }); continue; }
    const rc = rulesCheck(g.text, { claims: g.claims, neverPromotePatterns }); if (!rc.ok) { out.push({ ...g, rejected: 'rules: ' + rc.reason }); continue; }
    const done = { ...g, createdAt: now.toISOString() };
    try { done.score = scoreDraft(done); } catch { /* advisory only */ }
    out.push(done);
  }
  return out;
}

/** The top `ideaDraftsPerRun` ideas that are not in the queue yet, each through draftFromIdea and the carousel planner. A failed idea is logged with its reasons. */
export async function draftIdeas({ config = CONFIG, queue, ask, voice = voiceGate, rules = rulesCheck, now = new Date(), say = () => {}, queuePath = QUEUE_PATH, loadPool = loadIdeaPool, plan = planCarousel }) {
  const n = config.ideaDraftsPerRun === undefined ? DEFAULT_PER_RUN : config.ideaDraftsPerRun;
  if (!Number.isInteger(n) || n < 1) { say(`idea drafts: ideaDraftsPerRun must be a whole number >= 1 (got ${JSON.stringify(n)}): none drafted`); return []; }
  const pool = await loadPool({ queuePath, now }); if (!pool || !pool.ok) { say(`idea drafts: no pool, nothing asked (${pool?.reason ?? 'unknown'})`); return []; }
  const queued = new Set((queue?.drafts || []).map((x) => x.ideaId).filter(Boolean));
  const picks = pool.ideas.filter((i) => !queued.has(i.id)).slice(0, n); const made = [];
  const model = config.captionModel || DEFAULT_CAPTION_MODEL;
  for (const idea of picks) {
    let r;
    try { r = await draftFromIdea(idea, { ask, voice, rules, now, config, model, sourceNames: pool.sourceNames }); }
    catch (e) { if (e && e.guard) { say(`idea drafts: stopped by guard: ${e.message}`); break; } throw e; }
    if (!r.ok) { say(`idea draft failed (${idea.kind} ${idea.id}) after ${r.attempts} attempt(s): ${r.reasons.join(', ')}`); continue; }
    const p = await plan({ ...r.draft, id: 'idea' }, { voice, rules });
    if (!p.slides) { say(`idea draft failed (${idea.kind} ${idea.id}): carousel plan refused: ${p.rejected}`); continue; }
    made.push({ ...r.draft, slides: p.slides }); say(`idea draft ${idea.id} (${idea.kind}) ok after ${r.attempts} attempt(s)`);
  }
  return gateIdeaDrafts(made, { now });
}
