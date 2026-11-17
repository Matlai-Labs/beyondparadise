#!/usr/bin/env node
// Hand-written, approved hooks for the automatic lane (C2). The lane's own hook is the idea's cut title; a person may instead write a hook per idea, a
// second person-visible step approves it, and the lane uses it only while the idea's claims are exactly the ones it was written and approved against.
//
//   <state folder>/bpa-auto-hooks.json   { "hooks": [ { ideaId, sourceId, hook, claimsSha256, approvedBy, approvedAt, skipped? } ] }   the LANE file: private, mode 600, never committed
//     (proposals and approvals do not belong in a public repository, and a tap on a phone must not leave uncommitted changes in the live checkout)
//   auto-hooks.json   the committed file stays as the EMPTY default; it is no longer read by the lane. A fresh install runs `node auto-hooks.js --migrate auto-hooks.json` once.
//     `skipped` is absent, null or { by, at }: "not this wording" (state `skipped`: never taken by the lane; the review page shows and sets it)
//     an entry is bound to ONE idea: it matches on ideaId only (sourceId is kept for the reader), and `claimsSha256` is the hash of the idea's TITLE and its claim texts in order
//   node auto-hooks.js --add <ideaId> "<hook>"       looks the idea up in the real pool (read only), checks the hook like the on-video text, writes it UNAPPROVED
//   node auto-hooks.js --approve <ideaId> --by <text>   sets approvedBy and approvedAt (refused when the claims changed since --add)
//   node auto-hooks.js --list                         each entry with its state: approved, unapproved, stale
//   node auto-hooks.js --migrate <sourceFile>         copies the entries of another hooks file into the private file (never overwrites an entry for the same idea; writes nothing when anything is unusable)
//   [--file <path>] on every command: another hooks file (tests)
// readHooks fails closed: a missing or malformed file is an error, never "no hooks". Unapproved and stale entries are ignored by the lane (approvedHookFor).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir } from './stop.js';
import { withDecisionLock } from './decision-lock.js';

/** The approval label the review page stores in the hooks file (the claimed login lives only in the private decision record). */
export const REVIEW_BY = 'review page';

export const defaultHooksPath = (env = process.env) => path.join(stateDir(env), 'bpa-auto-hooks.json');
const SHA = /^[0-9a-f]{64}$/;
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** The hash an entry is bound to: the idea's TITLE and its claim texts, in order. A renamed idea, or a changed, added, removed or reordered claim, makes the entry stale. */
export const claimsSha256 = (idea) => crypto.createHash('sha256').update(JSON.stringify([typeof (idea && idea.title) === 'string' ? idea.title : null, (Array.isArray(idea && idea.claims) ? idea.claims : []).map((c) => (c && typeof c.text === 'string' ? c.text : null))])).digest('hex');

const entryProblem = (e) => {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'an entry is not an object';
  if (!text(e.ideaId)) return 'ideaId missing'; if (e.sourceId !== null && !text(e.sourceId)) return `sourceId of ${e.ideaId} must be text or null`;
  if (!text(e.hook)) return `hook of ${e.ideaId} missing`; if (!SHA.test(String(e.claimsSha256))) return `claimsSha256 of ${e.ideaId} is not a sha256`;
  if (e.skipped !== undefined && e.skipped !== null && !(typeof e.skipped === 'object' && !Array.isArray(e.skipped) && text(e.skipped.by) && typeof e.skipped.at === 'string' && !Number.isNaN(Date.parse(e.skipped.at)))) return `skipped of ${e.ideaId} must be null or { by, at }`;
  const by = e.approvedBy ?? null; const at = e.approvedAt ?? null;
  if (by === null && at === null) return null;
  if (!text(by) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return `approval of ${e.ideaId} needs both approvedBy (text) and approvedAt (a date), or neither`;
  return null;
};

/** { ok:true, hooks } | { ok:false, reason }. Fail closed. */
export function readHooks(file = defaultHooksPath()) {
  if (path.resolve(file) === path.resolve(defaultHooksPath())) { // the private lane file: a regular file only the owner can read (an explicit path, as tests and --file use, is not checked)
    let st; try { st = fs.lstatSync(file); } catch { st = null; }
    if (st && !st.isFile()) return { ok: false, reason: 'the hooks file must be a regular file' };
    if (st && (st.mode & 0o077) !== 0) return { ok: false, reason: 'the hooks file is readable by others (mode must be 600)' };
  }
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: `cannot read the hooks file (${e.code || e.message})` }; }
  let j; try { j = JSON.parse(raw); } catch { return { ok: false, reason: 'the hooks file is not valid JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.hooks)) return { ok: false, reason: 'the hooks file must be { "hooks": [...] }' };
  for (const e of j.hooks) { const p = entryProblem(e); if (p) return { ok: false, reason: p }; }
  return { ok: true, hooks: j.hooks };
}

/** 'approved' | 'unapproved' | 'stale' (the claims differ from the ones the entry was made against, or the idea is gone) | 'skipped' (the owner said "not this wording"; stale beats skipped). */
export function hookState(entry, idea) {
  if (!idea || entry.claimsSha256 !== claimsSha256(idea)) return 'stale';
  if (entry.skipped && typeof entry.skipped === 'object') return 'skipped';
  return text(entry.approvedBy) && typeof entry.approvedAt === 'string' ? 'approved' : 'unapproved';
}

/** The approved, current entry for an idea, matched on ideaId ONLY. Unapproved and stale entries are ignored. null when none.
 *  `includeUnapproved` (the rehearsal's preview, passed by nothing but auto-lane.js main) also accepts a current entry that is not approved yet; a stale one never. */
export function approvedHookFor(idea, hooks, { includeUnapproved = false } = {}) {
  const ok = (e) => { const st = hookState(e, idea); return st === 'approved' || (includeUnapproved && st === 'unapproved'); };
  return (Array.isArray(hooks) ? hooks : []).find((e) => e.ideaId === idea.id && ok(e)) || null;
}

/** The entry shown for an idea: the one the lane would take (approvedHookFor), else the LAST entry of that idea in file order. null when the idea has none. `others` counts the rest. */
export function shownEntry(hooks, idea) {
  const group = (Array.isArray(hooks) ? hooks : []).filter((e) => idea && e.ideaId === idea.id); if (!group.length) return null;
  return { entry: approvedHookFor(idea, group) || group[group.length - 1], others: group.length - 1 };
}

let tmpCounter = 0;
/** Write tmp then rename, so a reader sees the old file or the new one, never half. Mode 600, folder created when missing. */
export function writeHooksAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ } throw e; }
}
const writeAtomic = writeHooksAtomic;

/** --migrate: refuse (exit 3) before writing anything when the source, the pool or an existing target is unusable; one atomic write at the end. */
async function migrate(sourceFile, file, { deps, log, error, nowOf }) {
  const src = readHooks(sourceFile); if (!src.ok) { error(`refused: ${src.reason}`); return 3; }
  const loadPool = deps.loadPool || (async () => (await import('./idea-drafts.js')).loadIdeaPool({ now: nowOf() }));
  const pool = await loadPool(); if (!pool || !pool.ok) { error(`no pool: ${pool && pool.reason}`); return 3; }
  const ideas = new Map((pool.ideas || []).map((i) => [i.id, i]));
  const evaluate = deps.evaluate || (async (i, hook) => (await import('./auto-lane.js')).evaluateIdea(i, { now: nowOf(), hook, sourceNames: pool.sourceNames }));
  return withDecisionLock(async () => { // the target is read INSIDE the lock, so a page write and this write never lose each other
  let target = { ok: true, hooks: [] };
  let exists = true; try { fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') exists = false; }
  if (exists) { target = readHooks(file); if (!target.ok) { error(`refused: ${target.reason}`); return 3; } }
  const out = [...target.hooks]; const lines = [];
  for (const e of src.hooks) {
    if (out.some((x) => x.ideaId === e.ideaId)) { lines.push(`skipped ${e.ideaId}: already in the private file`); continue; }
    const idea = ideas.get(e.ideaId); const st = hookState(e, idea); let line = `migrated ${e.ideaId} ${st}`;
    if (st !== 'stale') { const r = await evaluate(idea, e.hook); if (!r.ok) line = `migrated ${e.ideaId} REFUSED-TODAY: ${r.reason}`; }
    out.push(e); lines.push(line);
  }
  writeHooksAtomic(file, { hooks: out }); for (const l of lines) log(l); return 0;
  });
}

export async function main(argv, deps = {}) {
  const log = deps.log || ((s) => console.log(s)); const error = deps.error || ((s) => console.error(s)); const nowOf = deps.now || (() => new Date());
  const a = { add: null, hook: null, approve: null, list: false, by: null, file: deps.file || null, migrate: null }; let bad = null;
  for (let i = 0; i < argv.length && !bad; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--list') a.list = true;
    else if (k === '--add') { if (v === undefined || argv[i + 2] === undefined || v.startsWith('--')) bad = '--add needs <ideaId> "<hook>"'; else { a.add = v; a.hook = argv[i + 2]; i += 2; } }
    else if (k === '--approve' || k === '--by' || k === '--file' || k === '--migrate') { if (v === undefined || v.startsWith('--')) bad = `${k} needs a value`; else { a[k.slice(2)] = v; i += 1; } }
    else bad = `unknown argument ${k}`;
  }
  if (!bad && [a.add !== null, a.approve !== null, a.list, a.migrate !== null].filter(Boolean).length !== 1) bad = 'give exactly one of --add, --approve, --list, --migrate';
  if (!bad && a.approve !== null && !text(a.by)) bad = '--approve needs --by <text>';
  if (bad) { error(`${bad}\nusage: auto-hooks.js --add <ideaId> "<hook>" | --approve <ideaId> --by <text> | --list | --migrate <sourceFile>  [--file <hooks.json>]`); return 2; }
  const file = a.file || defaultHooksPath();
  if (a.migrate !== null) return migrate(a.migrate, file, { deps, log, error, nowOf });
  const cur = readHooks(file); if (!cur.ok) { error(`refused: ${cur.reason}`); return 3; }
  const loadPool = deps.loadPool || (async () => (await import('./idea-drafts.js')).loadIdeaPool({ now: nowOf() }));
  const pool = await loadPool(); if (!pool || !pool.ok) { error(`no pool: ${pool && pool.reason}`); return 3; }
  const ideas = new Map((pool.ideas || []).map((i) => [i.id, i]));
  if (a.list) {
    if (!cur.hooks.length) log('no hand-written hooks');
    for (const e of cur.hooks) log(`${e.ideaId}  ${hookState(e, ideas.get(e.ideaId))}${e.approvedBy ? `  by ${e.approvedBy}` : ''}  ${e.hook}`);
    return 0;
  }
  if (a.approve !== null) {
    return withDecisionLock(async () => { // re-read inside the lock and change that fresh read
      const fresh = readHooks(file); if (!fresh.ok) { error(`refused: ${fresh.reason}`); return 3; }
      const e = fresh.hooks.find((x) => x.ideaId === a.approve); if (!e) { error(`unknown entry ${a.approve}`); return 4; }
      const st = hookState(e, ideas.get(e.ideaId)); if (st === 'stale') { error(`refused: the claims of ${e.ideaId} changed since the hook was added (stale): add it again`); return 4; }
      if (st === 'skipped') { error('refused: skipped on the review page; undo it there first'); return 4; }
      writeAtomic(file, { hooks: fresh.hooks.map((x) => (x === e ? { ...x, approvedBy: a.by.trim(), approvedAt: nowOf().toISOString() } : x)) });
      log(`approved: ${e.ideaId} by ${a.by.trim()}`); return 0;
    });
  }
  const idea = ideas.get(a.add); if (!idea) { error(`unknown idea ${a.add} (not in the real pool)`); return 4; }
  // the same checks the lane applies: length, figures only from the claims, the voice + rules final check, the deterministic judge checks (no clip needed here)
  const evaluate = deps.evaluate || (async (i, hook) => (await import('./auto-lane.js')).evaluateIdea(i, { now: nowOf(), hook, sourceNames: pool.sourceNames }));
  const r = await evaluate(idea, a.hook); if (!r.ok) { error(`refused: ${r.reason}`); return 4; }
  const entry = { ideaId: idea.id, sourceId: idea.sourceId ?? null, hook: r.draft.hook, claimsSha256: claimsSha256(idea), approvedBy: null, approvedAt: null };
  return withDecisionLock(async () => { // the evaluation above runs outside the lock; the read-modify-write below is inside it
    const fresh = readHooks(file); if (!fresh.ok) { error(`refused: ${fresh.reason}`); return 3; }
    writeAtomic(file, { hooks: [...fresh.hooks.filter((x) => x.ideaId !== idea.id), entry] });
    log(`added (UNAPPROVED): ${idea.id}  ${entry.hook}`); return 0;
  });
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
