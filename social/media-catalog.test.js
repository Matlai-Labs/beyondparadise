import './test-env.js';
// Tests for social/media-catalog.js — the rights and eligibility catalogue for the finished videos.
// Made-up file trees in a temp directory, an injected probe: no real media, no ffprobe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMediaName, scanMedia, autoEligible, mergeCatalog, writeFileAtomic, assertOutsideRepo, main,
  OVERLAY_WORD_THRESHOLD, PUBLISHER_MARK_SEED, RIGHTS_BASIS, countOnscreenWords,
} from './media-catalog.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-')));
const probe = async () => ({ durationSec: 12.5, width: 1920, height: 1080 });
const name = (date, title, id) => `${date} ${title} [${id}].mp4`;

/** files: { folder: [filename...] }, text: { 'folder/id': 'content' } */
function makeTree(files, text = {}) {
  const root = tmp();
  for (const [folder, list] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    for (const f of list) fs.writeFileSync(path.join(root, folder, f), 'x');
  }
  for (const [key, body] of Object.entries(text)) {
    const [folder, id] = key.split('/');
    fs.mkdirSync(path.join(root, 'analysis', folder), { recursive: true });
    fs.writeFileSync(path.join(root, 'analysis', folder, `${id}.onscreen.txt`), body);
  }
  return root;
}
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

// ---------- name parsing ----------
test('parseMediaName: plain name', () => {
  const r = parseMediaName(name('20250412', 'Luxury Trains', 'VU0u_qS4GpE'));
  assert.deepEqual(r, { uploadDate: '2025-04-12', title: 'Luxury Trains', id: 'VU0u_qS4GpE' });
});
test('parseMediaName: id starting with a dash, id with underscore, brackets in the title', () => {
  assert.equal(parseMediaName(name('20250417', 'Zimbabwe', '-0O22tResG0')).id, '-0O22tResG0');
  assert.equal(parseMediaName(name('20250417', 'A', 'ab_cd-ef_gh')).id, 'ab_cd-ef_gh');
  const r = parseMediaName(name('20250417', 'Top [10] places', 'VU0u_qS4GpE'));
  assert.equal(r.title, 'Top [10] places');
  assert.equal(r.id, 'VU0u_qS4GpE');
});
test('parseMediaName: no id, bad date or wrong length id gives null', () => {
  assert.equal(parseMediaName('20250412 Something.mp4'), null);
  assert.equal(parseMediaName('Something [VU0u_qS4GpE].mp4'), null);
  assert.equal(parseMediaName(name('20250412', 'T', 'short')), null);
  assert.equal(parseMediaName(name('20251399', 'T', 'VU0u_qS4GpE')), null);
});

// ---------- scan ----------
test('scanMedia: one record per video, relative path, kind, rights, flags, problems', async () => {
  const root = makeTree({
    africa: [name('20250420', 'Zanzibar things', 'AHy_3ubNY90'), 'AHy_3ubNY90.info.json', 'no id here.mp4'],
    asia: [name('20250308', 'Vietnam', 'hshRUpatiiQ')],
    'asia-shorts': [name('20250223', 'Vietnam short', 'qeEtDiABo0o')],
  });
  const { records, problems } = await scanMedia({ root, probe });
  assert.equal(records.length, 3);
  const z = records.find((r) => r.id === 'AHy_3ubNY90');
  assert.equal(z.file, path.join('africa', name('20250420', 'Zanzibar things', 'AHy_3ubNY90')));
  assert.equal(z.folder, 'africa');
  assert.equal(z.kind, 'full');
  assert.equal(z.uploadDate, '2025-04-20');
  assert.equal(z.durationSec, 12.5);
  assert.equal(z.width, 1920);
  assert.equal(z.height, 1080);
  assert.deepEqual(z.rights, { basis: RIGHTS_BASIS, document: null });
  assert.equal(RIGHTS_BASIS, 'owner statement of 2026-11-16: paid for, may be used');
  assert.equal(z.flags.personRecognisable, null);
  assert.equal(records.find((r) => r.id === 'qeEtDiABo0o').kind, 'short');
  assert.equal(problems.length, 1);
  assert.match(problems[0].file, /no id here/);
});
test('scanMedia: a failing probe leaves measures null and is reported, not thrown', async () => {
  const root = makeTree({ africa: [name('20250420', 'T', 'AHy_3ubNY90')] });
  const { records, problems } = await scanMedia({ root, probe: async () => { throw new Error('boom'); } });
  assert.equal(records[0].durationSec, null);
  assert.equal(records[0].width, null);
  assert.equal(problems.length, 1);
});
test('scanMedia: a missing folder is skipped, a duplicate id is reported once', async () => {
  const root = makeTree({
    africa: [name('20250420', 'T', 'AHy_3ubNY90')],
    asia: [name('20250421', 'T2', 'AHy_3ubNY90')],
  });
  const { records, problems } = await scanMedia({ root, probe });
  assert.equal(records.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /duplicate/);
});

// ---------- region ----------
test('region: from the folder; other when the title names a place outside both', async () => {
  const root = makeTree({
    africa: [name('20250420', 'Zanzibar', 'AAAAAAAAAAA'), name('20250413', 'Discover Namibia’s Wonders', 'BBBBBBBBBBB'),
      name('20250417', 'Discover Zimbabwe', 'CCCCCCCCCCC')],
    asia: [name('20250308', 'Vietnam', 'DDDDDDDDDDD')],
    'asia-shorts': [name('20250222', 'Cappadocia: Magical', 'EEEEEEEEEEE')],
  });
  const { records } = await scanMedia({ root, probe });
  const reg = Object.fromEntries(records.map((r) => [r.id, r.flags.region]));
  assert.equal(reg.AAAAAAAAAAA, 'east-africa');
  assert.equal(reg.BBBBBBBBBBB, 'other');
  assert.equal(reg.CCCCCCCCCCC, 'other');
  assert.equal(reg.DDDDDDDDDDD, 'asia');
  assert.equal(reg.EEEEEEEEEEE, 'other');
});

// ---------- overlay text ----------
test('countOnscreenWords ignores the [12s] time stamps', () => {
  assert.equal(countOnscreenWords('[0s] one two\n[12s] three\n'), 3);
  assert.equal(countOnscreenWords(''), 0);
});
test('overlayText: no file null; at the threshold false; one word more true', async () => {
  const root = makeTree({
    africa: [name('20250420', 'A', 'AAAAAAAAAAA'), name('20250420', 'B', 'BBBBBBBBBBB'),
      name('20250420', 'C', 'CCCCCCCCCCC'), name('20250420', 'D', 'DDDDDDDDDDD')],
  }, {
    'africa/BBBBBBBBBBB': `[0s] ${words(OVERLAY_WORD_THRESHOLD)}`,
    'africa/CCCCCCCCCCC': `[0s] ${words(OVERLAY_WORD_THRESHOLD + 1)}`,
    'africa/DDDDDDDDDDD': '',
  });
  const { records } = await scanMedia({ root, probe });
  const ov = Object.fromEntries(records.map((r) => [r.id, r.flags.overlayText]));
  assert.equal(ov.AAAAAAAAAAA, null);
  assert.equal(ov.BBBBBBBBBBB, false);
  assert.equal(ov.CCCCCCCCCCC, true);
  assert.equal(ov.DDDDDDDDDDD, false);
});

// ---------- publisher mark seed ----------
test('otherPublisherMark: the two audited ids are true, all others null', async () => {
  assert.deepEqual([...PUBLISHER_MARK_SEED].sort(), ['-0O22tResG0', 'NPNODhL-ZFU']);
  const root = makeTree({
    africa: [name('20250417', 'Zimbabwe', '-0O22tResG0'), name('20250420', 'Other', 'AHy_3ubNY90')],
    asia: [name('20250405', 'Laos', 'NPNODhL-ZFU')],
  });
  const { records } = await scanMedia({ root, probe });
  const m = Object.fromEntries(records.map((r) => [r.id, r.flags.otherPublisherMark]));
  assert.equal(m['-0O22tResG0'], true);
  assert.equal(m['NPNODhL-ZFU'], true);
  assert.equal(m.AHy_3ubNY90, null);
});

// ---------- autoEligible ----------
const clear = () => ({
  id: 'AHy_3ubNY90', file: 'africa/x.mp4', durationSec: 10, width: 1920, height: 1080,
  flags: { otherPublisherMark: false, overlayText: false, personRecognisable: false, region: 'east-africa' },
});
const here = { fileExists: () => true };
test('autoEligible: true only for the all-clear case', () => {
  const v = autoEligible(clear(), here);
  assert.equal(v.eligible, true);
  assert.deepEqual(v.reasons, []);
});
for (const flag of ['otherPublisherMark', 'overlayText', 'personRecognisable']) {
  test(`autoEligible: ${flag} null is not eligible`, () => {
    const r = clear(); r.flags[flag] = null;
    const v = autoEligible(r, here);
    assert.equal(v.eligible, false);
    assert.ok(v.reasons.some((x) => x.includes(flag)), v.reasons.join());
  });
  test(`autoEligible: ${flag} true is not eligible`, () => {
    const r = clear(); r.flags[flag] = true;
    const v = autoEligible(r, here);
    assert.equal(v.eligible, false);
    assert.ok(v.reasons.some((x) => x.includes(flag)));
  });
}
test('autoEligible: region, duration, file and config', () => {
  const r = clear(); r.flags.region = 'asia';
  assert.equal(autoEligible(r, here).eligible, false);
  assert.equal(autoEligible(r, { ...here, autoRegions: ['asia'] }).eligible, true);
  const nul = clear(); nul.flags.region = null;
  assert.equal(autoEligible(nul, here).eligible, false);
  const d = clear(); d.durationSec = null;
  assert.equal(autoEligible(d, here).eligible, false);
  assert.equal(autoEligible(clear(), { fileExists: () => false }).eligible, false);
  assert.equal(autoEligible(clear(), {}).eligible, false, 'cannot verify the file: fail closed');
  assert.equal(autoEligible({ ...clear(), flags: undefined }, here).eligible, false);
});
test('autoEligible: the file check uses config.root when no fileExists is given', () => {
  const root = makeTree({ africa: ['x.mp4'] });
  assert.equal(autoEligible(clear(), { root }).eligible, true);
  assert.equal(autoEligible({ ...clear(), file: 'africa/gone.mp4' }, { root }).eligible, false);
});

// ---------- merge ----------
const rec = (id, extra = {}) => ({
  id, file: `africa/${id}.mp4`, folder: 'africa', title: 't', uploadDate: '2025-01-01', kind: 'full',
  durationSec: 10, width: 1, height: 1, rights: { basis: RIGHTS_BASIS, document: null },
  flags: { otherPublisherMark: null, overlayText: null, personRecognisable: null, region: 'east-africa' }, ...extra,
});
test('mergeCatalog: keeps a hand-set flag and check fields, updates measures, reports a vanished file', () => {
  const existing = [
    rec('AAAAAAAAAAA', { flags: { otherPublisherMark: false, overlayText: false, personRecognisable: false, region: 'east-africa' },
      checkedBy: 'person', checkedAt: '2026-11-18' }),
    rec('BBBBBBBBBBB'),
  ];
  const scanned = [
    rec('AAAAAAAAAAA', { durationSec: 99, flags: { otherPublisherMark: null, overlayText: true, personRecognisable: null, region: 'east-africa' } }),
  ];
  const m = mergeCatalog(existing, scanned);
  const a = m.entries.find((e) => e.id === 'AAAAAAAAAAA');
  assert.equal(a.durationSec, 99);
  assert.equal(a.flags.overlayText, false, 'a set flag is not overwritten');
  assert.equal(a.checkedBy, 'person');
  assert.equal(a.checkedAt, '2026-11-18');
  assert.deepEqual(m.conflicts.map((c) => c.id), ['AAAAAAAAAAA']);
  assert.deepEqual(m.vanished, ['BBBBBBBBBBB']);
  assert.ok(m.entries.some((e) => e.id === 'BBBBBBBBBBB'), 'vanished entry is kept');
  assert.equal(m.entries.find((e) => e.id === 'BBBBBBBBBBB').missing, true);
});
test('mergeCatalog: null flags are filled from the scan, new files are added, missing is cleared', () => {
  const existing = [rec('AAAAAAAAAAA', { missing: true })];
  const scanned = [rec('AAAAAAAAAAA', { flags: { otherPublisherMark: true, overlayText: null, personRecognisable: null, region: 'east-africa' } }),
    rec('CCCCCCCCCCC')];
  const m = mergeCatalog(existing, scanned);
  assert.equal(m.entries.find((e) => e.id === 'AAAAAAAAAAA').flags.otherPublisherMark, true);
  assert.equal(m.entries.find((e) => e.id === 'AAAAAAAAAAA').missing, undefined);
  assert.deepEqual(m.added, ['CCCCCCCCCCC']);
  assert.deepEqual(mergeCatalog(null, scanned).added.sort(), ['AAAAAAAAAAA', 'CCCCCCCCCCC']);
});

// ---------- atomic write ----------
test('writeFileAtomic: mode 0600, replaces the old content', () => {
  const dir = tmp(); const p = path.join(dir, 'c.json');
  writeFileAtomic(p, 'one'); writeFileAtomic(p, 'two');
  assert.equal(fs.readFileSync(p, 'utf8'), 'two');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['c.json']);
});
test('writeFileAtomic: a write that fails half way leaves the old file intact and no temp file', () => {
  const dir = tmp(); const p = path.join(dir, 'c.json');
  writeFileAtomic(p, 'old');
  const failing = { ...fs, writeSync: (fd, data) => { fs.writeSync(fd, data.slice(0, 1)); throw new Error('disk full'); } };
  assert.throws(() => writeFileAtomic(p, 'new content', failing), /disk full/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['c.json']);
});

// ---------- the repository guard ----------
test('assertOutsideRepo: refuses paths inside the repository, including through ..', () => {
  const repo = tmp();
  const noGit = () => null;
  assert.throws(() => assertOutsideRepo(path.join(repo, 'social', 'c.json'), { repoRoot: repo, gitTopLevel: noGit }), /inside the repository/);
  assert.throws(() => assertOutsideRepo(path.join(repo, 'a', '..', 'c.json'), { repoRoot: repo, gitTopLevel: noGit }), /inside the repository/);
  assert.throws(() => assertOutsideRepo(path.join(tmp(), 'c.json'), { repoRoot: repo, gitTopLevel: () => '/some/other/repo' }), /git work tree/);
  assert.doesNotThrow(() => assertOutsideRepo(path.join(tmp(), 'c.json'), { repoRoot: repo, gitTopLevel: noGit }));
});
test('assertOutsideRepo: a symlink pointing into the repository is refused', () => {
  const repo = tmp(); const other = tmp();
  fs.symlinkSync(repo, path.join(other, 'link'));
  assert.throws(() => assertOutsideRepo(path.join(other, 'link', 'c.json'), { repoRoot: repo, gitTopLevel: () => null }), /inside the repository/);
});

// ---------- the command ----------
function run(argv, env, extra = {}) {
  const out = []; const err = [];
  return main(argv, env, { probe, gitTopLevel: () => null, log: (s) => out.push(s), error: (s) => err.push(s), ...extra })
    .then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}
test('command: --scan refuses to write the catalogue inside the repository', async () => {
  const root = makeTree({ africa: [name('20250420', 'T', 'AHy_3ubNY90')] });
  const repo = tmp();
  const target = path.join(repo, 'social', 'catalog.json');
  const r = await run(['--scan', '--root', root, '--out', target], {}, { repoRoot: repo });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /inside the repository/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.dirname(target)), false, 'no directory created either');
});
test('command: --scan writes 0600 outside, env defaults, second scan keeps a hand-set flag; --summary prints counts only', async () => {
  const root = makeTree({
    africa: [name('20250420', 'SecretTitle', 'AHy_3ubNY90'), name('20250417', 'Zimbabwe', '-0O22tResG0')],
    asia: [name('20250405', 'Laos', 'NPNODhL-ZFU')],
  }, { 'africa/AHy_3ubNY90': '' });
  const outFile = path.join(tmp(), 'sub', 'cat.json');
  const env = { BPA_MEDIA_ROOT: root, BPA_MEDIA_CATALOG: outFile };
  const repo = tmp();
  let r = await run(['--scan'], env, { repoRoot: repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
  const cat = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(cat.entries.length, 3);
  cat.entries.find((e) => e.id === 'AHy_3ubNY90').flags.personRecognisable = false;
  cat.entries.find((e) => e.id === 'AHy_3ubNY90').flags.otherPublisherMark = false;
  fs.writeFileSync(outFile, JSON.stringify(cat));
  r = await run(['--scan'], env, { repoRoot: repo });
  const again = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(again.entries.find((e) => e.id === 'AHy_3ubNY90').flags.personRecognisable, false);
  r = await run(['--summary'], env, { repoRoot: repo });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /africa: 2/);
  assert.match(r.out, /eligible for the automatic lane: 1/);
  assert.match(r.out, /AHy_3ubNY90/);
  assert.doesNotMatch(r.out, /SecretTitle/);
  assert.doesNotMatch(r.out, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('command: no flag prints usage and fails', async () => {
  const r = await run([], {}, { repoRoot: tmp() });
  assert.notEqual(r.code, 0);
});
