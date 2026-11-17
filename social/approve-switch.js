// The off switch for Approve on the review page: a private file `bpa-page-approve-on` in the state folder. Absent means off.
// Nothing in this code base writes it: the owner's word is what creates it. This module only LOOKS (lstat, never stat, never open).
import fs from 'node:fs'; import path from 'node:path';
import { stateDir } from './stop.js';

export const approveSwitchPath = (env = process.env) => path.join(stateDir(env), 'bpa-page-approve-on');

/** True only for a regular file (not a link, not a folder) that no other account can read or write and that belongs to the account running this server. Read on every call; any error is off (fail closed). `lstat` and `getuid` are test seams. */
export function approveSwitchOn(env = process.env, { lstat = fs.lstatSync, getuid = () => process.getuid() } = {}) {
  try { const st = lstat(approveSwitchPath(env)); return st.isFile() && (st.mode & 0o077) === 0 && typeof st.uid === 'number' && st.uid === getuid(); } catch { return false; }
}
