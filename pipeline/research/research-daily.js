'use strict';

// ============================================================
// research-daily.js — self-driving daily knowledge-base loop
//
// Works through research-queue.json in priority order (high→medium→low).
// Skips any item already present in facts.json or the candidates buffer.
// Researches N items per run, then auto-promotes confirmed facts.
// Resumable and idempotent — safe to run multiple times per day.
//
// Cost: 2 Gemini calls per item (1 grounded + 1 structure).
// At 3 items/day = 6 grounded calls — well within the 200/day cap.
//
//   node research-daily.js              # 3 items (default)
//   node research-daily.js --items=5    # 5 items
//   node research-daily.js --dry        # preview queue without calling API
//
// Logs to ../../logs/research.log
// Lock file: ../../.tmp/research-daily.lock (prevents overlapping runs)
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');
const LOG_FILE = path.join(ROOT, 'logs', 'research.log');
const LOCK = path.join(ROOT, '.tmp', 'research-daily.lock');
const QUEUE_FILE = path.join(__dirname, 'research-queue.json');

const cliArgs = process.argv.slice(2);
const arg = k => (cliArgs.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const DRY = cliArgs.includes('--dry');
const ITEMS = parseInt(arg('items') || '3', 10);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* log is best-effort */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function alreadyResearched(key) {
  const facts = (readJson(path.join(DATA_FACTS, 'facts.json'))?.facts || []);
  const candidates = (readJson(path.join(DATA_FACTS, 'facts.candidates.json'))?.candidates || []);
  const allKeys = new Set([
    ...facts.map(f => f._meta?.entityKey).filter(Boolean),
    ...candidates.map(c => c._meta?.entityKey).filter(Boolean),
    ...facts.map(f => f.id?.split('-').slice(0, -2).join('-')).filter(Boolean),
  ]);
  // Also check if any fact ID starts with the slugified key
  const slugKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const directMatch = [...facts, ...candidates].some(f => f.id?.startsWith(slugKey));
  return allKeys.has(key) || directMatch;
}

function worklist() {
  const queue = readJson(QUEUE_FILE);
  if (!queue || !queue.items) { log('No research-queue.json found'); return []; }

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return queue.items
    .filter(item => !alreadyResearched(item.key))
    .sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));
}

function main() {
  // Prevent overlapping runs
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 30 * 60 * 1000) { // 30 min
      log('Daily research: previous run still active (lock held) — skipping.'); return;
    }
    fs.unlinkSync(LOCK); // stale lock
  }

  const list = worklist();
  if (!list.length) {
    log('Daily research: queue fully researched. Add new items to research-queue.json or review held candidates.');
    return;
  }

  const todays = list.slice(0, ITEMS);
  log(`Daily research: ${list.length} items remaining; researching ${todays.length} today: ${todays.map(i => i.key).join(', ')}${DRY ? ' (DRY)' : ''}`);

  if (DRY) {
    todays.forEach(item => {
      console.log(`\n  [${item.priority}] ${item.key}`);
      console.log(`  cmd: node gather-facts.js --type=${item.type} --key=${item.key} --name="${item.name}" --topic=${item.topic} --region=${item.region}`);
      if (item.notes) console.log(`  notes: ${item.notes}`);
    });
    console.log(`\n  (--dry: nothing executed)`);
    return;
  }

  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));

  try {
    const NODE = process.execPath;
    let ok = 0, fail = 0;

    for (const item of todays) {
      log(`  Researching: ${item.key} (${item.type}, ${item.region})`);
      try {
        execSync(
          `"${NODE}" "${path.join(__dirname, 'gather-facts.js')}" ` +
          `--type=${item.type} --key=${item.key} --name="${item.name}" ` +
          `--topic=${item.topic} --region=${item.region}`,
          { cwd: ROOT, stdio: 'inherit', timeout: 300000 }
        );
        ok++;
      } catch (e) {
        log(`  ! ${item.key} failed: ${(e.message || '').split('\n')[0]} — continuing`);
        fail++;
      }
    }

    // Auto-promote confirmed facts (single-source stays in buffer for Tim's review)
    let promoteLine = '';
    try {
      const out = execSync(
        `"${NODE}" "${path.join(__dirname, 'promote-fact.js')}" --all`,
        { cwd: ROOT, encoding: 'utf8', timeout: 60000 }
      );
      promoteLine = (out.match(/promoted:.*/) || [''])[0];
    } catch (e) {
      promoteLine = 'promote step failed: ' + (e.message || '').split('\n')[0];
    }

    const factsCount = (readJson(path.join(DATA_FACTS, 'facts.json'))?.facts || []).length;
    const pending = (readJson(path.join(DATA_FACTS, 'facts.candidates.json'))?.candidates || []).length;
    log(`Daily research done: ok=${ok} fail=${fail} | ${promoteLine} | KB: ${factsCount} facts, ${pending} candidates pending review`);

  } finally {
    try { fs.unlinkSync(LOCK); } catch { /* */ }
  }
}

main();
