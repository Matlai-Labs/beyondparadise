import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.worktrees', '_astro', '.astro', '.next', '.cache']);

/** Recursively list files with one of `exts` (lowercase, with dot). Symlinks are not followed. */
export function walk(dir, exts, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (e.isFile() && (!exts || exts.includes(path.extname(e.name).toLowerCase()))) out.push(p);
  }
  return out;
}

/** Expand a mix of files and directories into files. */
export function expand(paths, exts) {
  const out = [];
  for (const p of paths) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (!exts || exts.includes(path.extname(p).toLowerCase())) out.push(p);
  }
  return out;
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Tiny argv parser: positional[], flags{ --k v | --k }. */
export function parseArgs(argv, boolFlags = []) {
  const positional = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (boolFlags.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

export const isMain = (metaUrl) => process.argv[1] && new URL(metaUrl).pathname === fs.realpathSync(process.argv[1]);
