// Per-fact verification dates. No global "last verified" label: each fact is only as fresh as its
// own check. Tier-1 (official) sources define the date when present (oldest of them); otherwise the
// oldest source date. A freshly re-read secondary source can never make a stale fact look current.
export function factVerifiedDate(sources, fallback) {
  const dated = (sources || []).filter(s => s && s.accessed);
  const t1 = dated.filter(s => s.tier === 1);
  const pool = (t1.length ? t1 : dated).map(s => s.accessed).sort();
  const d = pool[0] || fallback || '';
  if (!d) throw new Error('fact has no verification date');
  return d;
}
export const oldestDate = ds => [...ds].sort()[0];
export const newestDate = ds => [...ds].sort().pop();
