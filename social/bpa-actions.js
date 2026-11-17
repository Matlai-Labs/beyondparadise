// State-changing actions shared by the WhatsApp `bpa` commands and the review page.
import fs from 'node:fs';
import path from 'node:path';
import { STATUS, CONFIG, QUEUE_PATH, log } from './lib.js';
import { engageStop, releaseStop } from './stop.js';
import { REVIEW_BY, defaultHooksPath, readHooks, writeHooksAtomic, hookState, shownEntry, claimsSha256 } from './auto-hooks.js';
import { localParts } from './plain-time.js';
import { INVISIBLE } from './invisible-chars.js';
import { DRAFT_REASONS } from './draft-version.js';
import { withDecisionLock } from './decision-lock.js';
import { CLIP_REASONS, HOOK_REASONS, hookVersion, clipReasonOf, laneClipsOf } from './review-items.js';
import { defaultClipApprovalsPath, readClipApprovals, writeClipApprovals, clipVersion, tagsOf, decisionOf, setDecision, clearDecision, maybeEnforce, stockRightsProblem } from './clip-approvals.js';
/** One plain sentence about Facebook posts already scheduled at Meta (stop does not cancel them). Reads the queue WITHOUT the lock; a parse error leaves the sentence out. */
export function scheduledAtMetaNote(queuePath, now = new Date(), tz = CONFIG.timezone) {
  let q; try { q = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { return ''; }
  const times = (Array.isArray(q?.drafts) ? q.drafts : []).filter((d) => d?.status === STATUS.SCHEDULED && Date.parse(d.scheduledFor) > now.getTime()).map((d) => Date.parse(d.scheduledFor)).sort((x, y) => x - y);
  if (!times.length) return '';
  const p = localParts(times[0], tz);
  const when = `${p.day} ${p.month} ${p.hour}:${p.minute}`;
  return times.length === 1 ? `1 Facebook post is already scheduled at Meta for ${when} and will still go out; cancel it in Meta if needed.`
    : `${times.length} Facebook posts are already scheduled at Meta, the next for ${when}, and will still go out; cancel them in Meta if needed.`;
}
/** Stop posting. `reply` is exactly what `bpa stop` answers (it already ends with the note); `note` is the Meta sentence alone. No queue lock. */
export function stopPosting({ queuePath = QUEUE_PATH, stopOpts, now = new Date() } = {}) {
  const note = scheduledAtMetaNote(queuePath, now);
  return { reply: engageStop(stopOpts) + (note ? ` ${note}` : ''), note };
}
/** Allow posting again. `reply` is exactly what `bpa start` answers. */
export function startPosting({ stopOpts } = {}) { return { reply: releaseStop(stopOpts) }; }

// ── review page decisions (step 2): approve, skip, undo, edit for video texts and clips ─────────────────────────────
// Common order inside the decision lock: read state -> find the item -> compare the version with the one recomputed NOW -> state rules -> usable-now rules
// -> record (ctx.record) -> write the state file atomically. A failed record means "not decided"; a failed state write voids the record line.
export const ACTION_CODES = Object.freeze(['bad-request', 'bad-characters', 'not-found', 'version-changed', 'stale', 'already-approved', 'already-skipped', 'not-decided', 'already-used', 'rights-missing', 'version-pending', 'no-change', 'usage-unreadable', 'history-unreadable', 'check-failed', 'approvals-unreadable', 'hooks-unreadable', 'ideas-unavailable', 'library-unreadable', 'record-failed', 'write-failed', 'lock-busy', 'cannot-decide', 'still-stopped', 'could-not-stop', 'stop-changed',
  // step 3: draft decisions
  'queue-unreadable', 'already-scheduled', 'already-posted', 'expired', 'blocked', 'stopped', 'text-missing', 'sources-missing', 'sources-old', 'sources-outdated', 'sources-too-few', 'brand-rule', 'voice-rule', 'rules', 'number-not-in-facts', 'schedule-failed', 'schedule-not-saved', 'not-pending', 'check-meta', 'slot-changed', 'text-too-long']);
// the BASE (before any ':') of every reason evaluateIdea and the checks behind it can return (auto-lane.js, fact-post.js, the final check)
export const EVAL_REASONS = Object.freeze(['hook-number-not-in-claims', 'hook-subject-mismatch', 'hook-too-long', 'hook-invalid', 'idea-has-no-claims', 'title-missing', 'title-too-long', 'title-has-markup', 'title-claim-differ', 'claim-too-long', 'claim-multiline', 'no-subject', 'no-matching-clip', 'no-approved-hook', 'wrong-kind', 'in-history', 'bad-config', 'final-check', 'alt-text', 'judge']);
const OPEN_SET = new Set([...ACTION_CODES, ...CLIP_REASONS, ...HOOK_REASONS, ...EVAL_REASONS, ...DRAFT_REASONS]);
/** THE closed set (C1): only the base of a code that is in the set leaves; text built from data becomes 'check-failed'. */
export function publicCode(code) {
  if (typeof code !== 'string' || !/^[a-z0-9:_-]{1,60}$/.test(code)) return 'check-failed';
  const base = code.split(':')[0];
  return OPEN_SET.has(base) ? base : 'check-failed';
}
// SR2: refuse every control, format, private-use and unassigned character, line and paragraph separators, every space except the plain U+0020, variation selectors, and the fillers that draw nothing. The page (review-page.html BAD_EDIT_CHARS) holds the same set; review-test-chars.js tests both.

const LINEBREAK = /[\r\n\u2028\u2029\u0085]/;
const fail = (code) => ({ ok: false, code: publicCode(code) });
const okOf = (kind, id, decision, extra = {}) => ({ ok: true, change: { kind, id, decision }, ...extra });
const validReq = (req) => Boolean(req) && typeof req.id === 'string' && req.id !== '' && typeof req.version === 'string';
const isSuperseded = (c) => Array.isArray(c.supersededBy) && c.supersededBy.length > 0;
const insideDir = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const inHistoryAny = (idea, history) => (Array.isArray(history) ? history : []).some((h) => h && ((h.sourceId != null && (h.sourceId === idea.sourceId || h.sourceId === idea.id)) || (h.ideaId != null && h.ideaId === idea.id)));

export function createActions({ env = process.env, now = () => new Date(), hooksFile = defaultHooksPath(env), approvalsFile = defaultClipApprovalsPath(env), lockTimeoutMs = 5000, loadPool, evaluate, readManifest, libraryDir, info, readUsage, readHistory }) {
  const stamp = () => now().toISOString();
  async function locked(fn) {
    try { return await withDecisionLock(fn, { env, timeoutMs: lockTimeoutMs }); }
    catch (e) { return fail(e && e.code === 'lock-busy' ? 'lock-busy' : 'check-failed'); }
  }
  /** record first, then the state write; a failure of either means "not decided" (null = decided) */
  function commit(ctx, rec, write) {
    let r; try { r = ctx.record(rec); } catch { r = null; }
    if (!r || r.ok !== true) return 'record-failed';
    try { write(); return null; } catch {
      let v; try { v = ctx.voidRecord(r.n); } catch { v = null; }
      if (!v || v.ok !== true) log('review failed: void-record-failed');
      return 'write-failed';
    }
  }
  async function freshPool() {
    let p; try { p = await loadPool(); } catch { p = null; }
    if (!p || !p.ok || !Array.isArray(p.ideas)) return null;
    return { map: new Map(p.ideas.map((i) => [i.id, i])), sourceNames: p.sourceNames || {} };
  }
  const hookList = () => { const h = readHooks(hooksFile); return h.ok ? h.hooks : null; };
  /** null = not used in any post; else the code. A history that cannot be read fails closed. */
  const usedProblem = (idea) => { let h; try { h = readHistory(); } catch { return 'history-unreadable'; } if (!Array.isArray(h)) return 'history-unreadable'; return inHistoryAny(idea, h) ? 'already-used' : null; };
  async function runEvaluate(idea, hook, pool) {
    let r; try { r = await evaluate(idea, { hook, sourceNames: pool.sourceNames, now: now() }); } catch { r = null; }
    return r && typeof r === 'object' ? r : { ok: false, reason: 'check-failed' };
  }

  // ── video texts ──
  /** What the decision rules need, read fresh: { code } | { hooks, pool, idea, entry, st, version } */
  async function readHookState(req) {
    const hooks = hookList(); if (!hooks) return { code: 'hooks-unreadable' };
    const pool = await freshPool(); if (!pool) return { code: 'ideas-unavailable' };
    const idea = pool.map.get(req.id); if (!idea) return { code: 'not-found' };
    const sh = shownEntry(hooks, idea); if (!sh) return { code: 'not-found' };
    return { hooks, pool, idea, entry: sh.entry, st: hookState(sh.entry, idea), version: hookVersion(sh.entry.hook, idea) };
  }
  // the state rules of approve, in the one order both phases use
  const approveRule = (st) => (st === 'stale' ? 'stale' : st === 'skipped' ? 'already-skipped' : st === 'approved' ? 'already-approved' : null);
  /** CR5: Approve checks OUTSIDE the lock, like edit: a slow check must not turn every other decision into lock-busy. Phase B re-reads under the lock and
   *  re-applies the state rules and the version, and the claims must still hash the same, so the text the checks saw is the text that is approved. */
  async function approveHookDecision(req, ctx) {
    if (!validReq(req)) return fail('bad-request');
    const a = await readHookState(req); if (a.code) return fail(a.code);
    const rule = approveRule(a.st); if (rule) return fail(rule);
    if (req.version !== a.version) return fail('version-changed');
    const r = await runEvaluate(a.idea, a.entry.hook, a.pool); if (!r.ok) return fail(r.reason); // D7: the checks must pass right now
    const seenClaims = claimsSha256(a.idea);
    return locked(async () => {
      const b = await readHookState(req); if (b.code) return fail(b.code);
      const rule2 = approveRule(b.st); if (rule2) return fail(rule2);
      if (req.version !== b.version || b.entry.hook !== a.entry.hook || claimsSha256(b.idea) !== seenClaims) return fail('version-changed');
      const next = { ...b.entry, approvedBy: REVIEW_BY, approvedAt: stamp() };
      const bad = commit(ctx, { kind: 'hook', id: req.id, version: b.version, decision: 'approve' }, () => writeHooksAtomic(hooksFile, { hooks: b.hooks.map((x) => (x === b.entry ? next : x)) }));
      return bad ? fail(bad) : okOf('hook', req.id, 'approved');
    });
  }
  async function hookDecision(req, ctx, word) {
    if (!validReq(req)) return fail('bad-request');
    return locked(async () => {
      const hooks = hookList(); if (!hooks) return fail('hooks-unreadable');
      const pool = await freshPool(); if (!pool) return fail('ideas-unavailable');
      const idea = pool.map.get(req.id); if (!idea) return fail('not-found');
      const sh = shownEntry(hooks, idea); if (!sh) return fail('not-found');
      const entry = sh.entry; const st = hookState(entry, idea); const version = hookVersion(entry.hook, idea);
      let next; let decision;
      if (word === 'skip') {
        if (st === 'stale') return fail('stale'); if (st === 'skipped') return fail('already-skipped');
        if (req.version !== version) return fail('version-changed');
        next = { ...entry, approvedBy: null, approvedAt: null, skipped: { by: REVIEW_BY, at: stamp() } }; decision = 'skipped';
      } else {
        if (st !== 'approved' && st !== 'skipped') return fail('not-decided');
        let history; try { history = readHistory(); } catch { return fail('history-unreadable'); }
        if (!Array.isArray(history)) return fail('history-unreadable');
        if (inHistoryAny(idea, history)) return fail('already-used');
        if (req.version !== version) return fail('version-changed');
        const { skipped, ...rest } = entry; next = { ...rest, approvedBy: null, approvedAt: null }; decision = 'undone';
      }
      const bad = commit(ctx, { kind: 'hook', id: req.id, version, decision: word }, () => writeHooksAtomic(hooksFile, { hooks: hooks.map((x) => (x === entry ? next : x)) }));
      return bad ? fail(bad) : okOf('hook', req.id, decision);
    });
  }

  async function editHook(req, ctx) {
    if (!validReq(req) || typeof req.text !== 'string') return fail('bad-request');
    const text = req.text.trim();
    if (text === '' || LINEBREAK.test(text)) return fail('bad-request');
    if (INVISIBLE.test(text)) return fail('bad-characters');
    // phase A, no lock: the slow check must not hold it
    const pool = await freshPool(); if (!pool) return fail('ideas-unavailable');
    const idea = pool.map.get(req.id); if (!idea) return fail('not-found');
    const hooks = hookList(); if (!hooks) return fail('hooks-unreadable');
    const sh = shownEntry(hooks, idea); if (!sh) return fail('not-found');
    const used = usedProblem(idea); if (used) return fail(used); // an idea already in a post is not edited any more (like undo)
    if (hookVersion(sh.entry.hook, idea) !== req.version) return fail('version-changed'); // a stale entry is allowed: editing is the fix
    if (text === sh.entry.hook) return fail('no-change');
    const r = await runEvaluate(idea, text, pool); if (!r.ok) return fail(r.reason);
    if (!r.draft || r.draft.hook !== text) return fail('check-failed'); // the stored text is exactly the text the checks saw
    const seenClaims = claimsSha256(idea); const seenEntry = JSON.stringify(sh.entry);
    // phase B, under the lock: nothing may have changed while the checks ran
    return locked(async () => {
      const hooks2 = hookList(); if (!hooks2) return fail('hooks-unreadable');
      const pool2 = await freshPool(); if (!pool2) return fail('ideas-unavailable');
      const idea2 = pool2.map.get(req.id); if (!idea2 || claimsSha256(idea2) !== seenClaims) return fail('version-changed');
      const used2 = usedProblem(idea2); if (used2) return fail(used2);
      const sh2 = shownEntry(hooks2, idea2);
      if (!sh2 || JSON.stringify(sh2.entry) !== seenEntry || hookVersion(sh2.entry.hook, idea2) !== req.version) return fail('version-changed');
      const entry = { ideaId: idea2.id, sourceId: idea2.sourceId ?? null, hook: text, claimsSha256: seenClaims, approvedBy: REVIEW_BY, approvedAt: stamp() };
      const bad = commit(ctx, { kind: 'hook', id: req.id, version: hookVersion(text, idea2), decision: 'edit' }, () => writeHooksAtomic(hooksFile, { hooks: [...hooks2.filter((x) => x.ideaId !== idea2.id), entry] }));
      return bad ? fail(bad) : okOf('hook', req.id, 'edited');
    });
  }

  // ── clips ──
  const readManifestSafe = () => { try { const m = readManifest(); return m && Array.isArray(m.clips) ? m : null; } catch { return null; } };
  const findClip = (m, id) => m.clips.find((c) => c && c.id === id) || null;
  /** phase A, no lock: the clip, its file identity and the version computed NOW. { code } | { clip, abs, pk, sha, version } */
  async function lookClip(req, { rights }) {
    const m = readManifestSafe(); if (!m) return { code: 'library-unreadable' };
    const clip = findClip(m, req.id); if (!clip || isSuperseded(clip)) return { code: 'not-found' };
    if (rights && stockRightsProblem(clip)) return { code: 'rights-missing' };
    if (typeof clip.file !== 'string' || clip.file === '' || !insideDir(libraryDir, clip.file)) return { code: 'video-missing' };
    const abs = path.resolve(libraryDir, clip.file); const pk = info.peek(abs); if (!pk) return { code: 'video-missing' }; // never a hash of nothing
    let sha = pk.sha256; if (sha === null) { try { sha = await info.hash(abs, pk); } catch { return { code: 'version-pending' }; } }
    if (typeof sha !== 'string') return { code: 'version-pending' };
    const version = clipVersion(sha, tagsOf(clip)); if (version !== req.version) return { code: 'version-changed' };
    return { clip, abs, pk, sha, version };
  }
  /** phase B, inside the lock: the same file and tags as phase A. { code } | { manifest, clip } */
  function lookAgain(req, a) {
    const m = readManifestSafe(); if (!m) return { code: 'library-unreadable' };
    const clip = findClip(m, req.id); if (!clip || isSuperseded(clip)) return { code: 'not-found' };
    const pk = info.peek(a.abs); if (!pk || pk.key !== a.pk.key) return { code: 'version-changed' };
    if (clipVersion(a.sha, tagsOf(clip)) !== req.version) return { code: 'version-changed' };
    return { manifest: m, clip };
  }
  const readApprovals = () => { const r = readClipApprovals(approvalsFile); return r.ok ? r.data : null; };
  const usageOf = () => { try { const u = readUsage(); return Array.isArray(u) ? u : null; } catch { return null; } };
  /** the clips the lane could take today, each with the version it would be decided under (a clip not hashed yet gets a version no decision matches) */
  function currentClips(manifest, usage, self) {
    return laneClipsOf(manifest, usage, libraryDir).map((c) => {
      if (c.id === self.id) return { id: c.id, version: self.version };
      const pk = typeof c.file === 'string' ? info.peek(path.resolve(libraryDir, c.file)) : null;
      return { id: c.id, version: pk && pk.sha256 ? clipVersion(pk.sha256, tagsOf(c)) : 'pending' };
    });
  }

  async function clipDecision(req, ctx, word) {
    if (!validReq(req)) return fail('bad-request');
    const a = await lookClip(req, { rights: word === 'approve' }); if (a.code) return fail(a.code);
    return locked(async () => {
      const b = lookAgain(req, a); if (b.code) return fail(b.code);
      const usage = usageOf();
      if (word !== 'skip' && usage === null) return fail('usage-unreadable');
      const data = readApprovals(); if (!data) return fail('approvals-unreadable');
      const d = decisionOf(data, req.id, a.version);
      let next; let decision;
      if (word === 'approve') {
        if (!laneClipsOf(b.manifest, usage, libraryDir).some((c) => c.id === req.id)) return fail(clipReasonOf(b.manifest, usage, libraryDir, b.clip, { info }).reason || 'not-usable'); // D8
        if (d === 'approved') return fail('already-approved'); if (d === 'skipped') return fail('already-skipped');
        next = setDecision(data, req.id, 'approved', { version: a.version, at: stamp() }); decision = 'approved';
      } else if (word === 'skip') {
        if (d === 'skipped') return fail('already-skipped');
        next = setDecision(data, req.id, 'skipped', { version: a.version, at: stamp() }); decision = 'skipped';
      } else {
        if (d === 'undecided') return fail('not-decided');
        const free = new Set(laneClipsOf(b.manifest, [], libraryDir).map((c) => c.id)); const open = new Set(laneClipsOf(b.manifest, usage, libraryDir).map((c) => c.id));
        if (free.has(req.id) && !open.has(req.id)) return fail('already-used');
        next = clearDecision(data, req.id); decision = 'undone';
      }
      let enforced = false;
      if (word !== 'undo') { const cur = currentClips(b.manifest, usage === null ? [] : usage, { id: req.id, version: a.version }); const e = maybeEnforce(next, cur, stamp()); enforced = !data.enforcedAt && Boolean(e.enforcedAt); next = e; }
      const bad = commit(ctx, { kind: 'clip', id: req.id, version: a.version, decision: word }, () => writeClipApprovals(approvalsFile, next));
      return bad ? fail(bad) : okOf('clip', req.id, decision, enforced ? { enforced: true } : {});
    });
  }

  return {
    approveHook: approveHookDecision, skipHook: (req, ctx) => hookDecision(req, ctx, 'skip'), unapproveHook: (req, ctx) => hookDecision(req, ctx, 'undo'), editHook,
    approveClip: (req, ctx) => clipDecision(req, ctx, 'approve'), skipClip: (req, ctx) => clipDecision(req, ctx, 'skip'), unapproveClip: (req, ctx) => clipDecision(req, ctx, 'undo'),
  };
}
