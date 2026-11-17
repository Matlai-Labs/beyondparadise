// The status line of the review page: lane on or off, stop state, last post, last worker run. Read only, never throws, no paths in the result.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopStatus } from './stop.js';
import { runStatePathFor, lastPostPathFor } from './health.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const validTime = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const readObj = (file) => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };

export function readStatus({ env = process.env, configFile = path.join(HERE, 'config.json'), runStatePath = runStatePathFor(env), lastPostPath = lastPostPathFor(env), stop = stopStatus } = {}) {
  const cfg = readObj(configFile);
  const autoLane = !cfg ? 'unknown' : (cfg.autoPublish === true ? 'on' : 'off'); // fresh from disk: the server's CONFIG is read once at start
  let stopped; try { const s = stop({ env }); stopped = s && typeof s.stopped === 'boolean' ? { stopped: s.stopped, reason: typeof s.reason === 'string' ? s.reason : null } : 'unknown'; } catch { stopped = 'unknown'; }
  const post = readObj(lastPostPath); const run = readObj(runStatePath);
  return {
    autoLane, stop: stopped,
    lastPost: post && validTime(post.at) ? { at: post.at, id: String(post.id ?? '') } : 'unknown',
    lastRun: run && validTime(run.lastRunAt) ? { at: run.lastRunAt, result: typeof run.result === 'string' ? run.result : 'unknown' } : 'unknown',
  };
}
