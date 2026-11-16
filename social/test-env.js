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
process.env.BPA_QUIET = '1';
export const TEST_ENV_DIR = dir;
