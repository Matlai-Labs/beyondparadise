// Import this FIRST in every *.test.js (ES imports run in order, so it is set before lib.js reads its paths).
// It points every file the pipeline writes or reads outside the repo at a throwaway folder:
// the real social.log, the stop flags, the Instagram ledger and the run/last-post/alert state.
// 2026-11: lib.test.js used to write hundreds of "whatsapp skipped" lines into the REAL log.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-test-env-'));
process.env.BPA_LOG_PATH = path.join(dir, 'social.log');
process.env.BPA_STATE_DIR = path.join(dir, 'state');
process.env.BPA_STOP_FLAG = path.join(dir, 'state', 'bpa-social-stop');
process.env.STOP_ALL_FLAG_PATH = path.join(dir, 'state', 'stop-all.flag');
process.env.BPA_NEVER_PROMOTE_FILE = path.join(dir, 'bpa-never-promote.json'); // a made-up list: tests never read the real ~/.matlai one
fs.writeFileSync(process.env.BPA_NEVER_PROMOTE_FILE, JSON.stringify({ patterns: ['examplehotel'] }));
// The three doors to the real world, closed for every test (a test that forgot to inject a function must fail, not post, alert or write the live queue):
// the Meta publisher and its tokens point at files that do not exist; the alert number is empty and its private file does not exist; the queue is a throwaway file.
process.env.META_PUBLISH_PATH = path.join(dir, 'no-meta-publish.js');
process.env.META_TOKENS_PATH = path.join(dir, 'no-meta-tokens.json');
process.env.WHATSAPP_ALERT_TO_FILE = path.join(dir, 'no-alert-number');
process.env.WHATSAPP_ALERT_TO = '';
process.env.BPA_QUEUE_PATH = path.join(dir, 'queue.json');
fs.writeFileSync(process.env.BPA_QUEUE_PATH, JSON.stringify({ seq: 0, drafts: [] }));
process.env.BPA_QUIET = '1';
export const TEST_ENV_DIR = dir;
