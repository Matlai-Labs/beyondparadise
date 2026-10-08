// Search Console exports -> plain objects. Dependency-free. The generative-AI parser is a port of
// SEO_and_AI_Performance_Program/backend/app/services/gsc/generative_ai_import.py (same rules).
import { normalizePath } from './html.mjs';

export const MISSING_IMPRESSIONS_MESSAGE = "This doesn't look like a Search Console export. Open Performance → Search generative AI → Export → Download CSV.";

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const DIM = [['page', 'page'], ['url', 'page'], ['country', 'country'], ['device', 'device'], ['date', 'date'], ['quer', 'query']];
const detectDimension = (h) => { const l = h.trim().toLowerCase(); for (const [n, d] of DIM) if (l.includes(n)) return d; return 'page'; };
const findCol = (header, needle) => { const i = header.findIndex((c) => c.trim().toLowerCase().includes(needle)); return i < 0 ? null : i; };
function parseCount(raw) {
  const c = raw.trim().replace(/[,.  ]/g, '');
  if (c === '') return 0;
  return /^\d+$/.test(c) ? parseInt(c, 10) : null;
}

/** Search Console "Search generative AI performance" CSV. clicks/queries are optional. Throws on a non-GSC file. */
export function parseGenerativeAiCsv(text) {
  const all = parseCsv(text);
  const header = all[0];
  if (!header || !header.length || (header.length === 1 && !header[0].trim())) throw new Error(MISSING_IMPRESSIONS_MESSAGE);
  const impIdx = findCol(header, 'impression');
  if (impIdx === null) throw new Error(MISSING_IMPRESSIONS_MESSAGE);
  const clickIdx = findCol(header, 'click');
  const dimension = detectDimension(header[0]);
  const rows = []; let skippedRows = 0;
  for (const r of all.slice(1)) {
    if (!r.length || !r.some((c) => c.trim())) continue;
    const key = (r[0] || '').trim();
    if (!key || ['total', 'totals'].includes(key.toLowerCase())) continue;
    const imp = parseCount(impIdx < r.length ? r[impIdx] : '');
    if (imp === null) { skippedRows++; continue; }
    let clicks = null;
    if (clickIdx !== null && clickIdx < r.length && r[clickIdx].trim()) { const c = parseCount(r[clickIdx]); if (c !== null) clicks = c; }
    rows.push({ key, impressions: imp, clicks });
  }
  if (!rows.length && skippedRows > 0) throw new Error(MISSING_IMPRESSIONS_MESSAGE);
  return { dimension, rows, skippedRows };
}

const num = (s) => { const n = parseFloat(String(s).replace('%', '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const toPath = (u) => { try { return normalizePath(new URL(u).pathname); } catch { return normalizePath(String(u).trim()); } };

/** Page-level performance export (CSV, GSC-API JSON {rows:[{keys}]}, or [{page,…}]) -> [{path,clicks,impressions,ctr,position}] */
export function parseGscPages(text) {
  const t = text.trim();
  let rows;
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : j.rows || [];
    rows = arr.map((r) => ({ page: r.keys ? r.keys[0] : r.page || r.url, clicks: +r.clicks || 0, impressions: +r.impressions || 0, ctr: r.ctr, position: +r.position || 0 }));
  } else {
    const all = parseCsv(t); const h = all[0].map((c) => c.trim().toLowerCase());
    const ix = (n) => h.findIndex((c) => c.includes(n));
    const [pi, ci, ii, ti, po] = [0, ix('click'), ix('impression'), ix('ctr'), ix('position')];
    rows = all.slice(1).filter((r) => r[0]?.trim() && !/^totals?$/i.test(r[0].trim())).map((r) => ({
      page: r[pi], clicks: ci >= 0 ? num(r[ci]) : 0, impressions: ii >= 0 ? num(r[ii].replace(/[,.  ](?=\d{3}\b)/g, '')) : 0,
      ctr: ti >= 0 && r[ti] !== '' ? num(r[ti]) / (String(r[ti]).includes('%') ? 100 : 1) : undefined, position: po >= 0 ? num(r[po]) : 0,
    }));
  }
  return rows.filter((r) => r.page).map((r) => ({
    path: toPath(r.page), clicks: r.clicks, impressions: r.impressions,
    ctr: r.ctr !== undefined && r.ctr !== null && !Number.isNaN(+r.ctr) ? +r.ctr : r.impressions ? r.clicks / r.impressions : 0, position: r.position,
  }));
}
export { toPath };
