// Build-time statistics generator. Reads data/facts/facts.json (via the @data alias) and turns a
// curated list of CONFIRMED facts into citeable statistics with source URLs and dates.
//
// Guard rails (these throw at build time, so a bad edit cannot ship):
//   - the fact must exist and have status "confirmed"
//   - the fact must resolve to >= 1 source URL
//   - the displayed number must literally appear in the fact text (`must`)
// Refreshing: edit nothing here when facts are re-verified - rebuild and the page, CSV, Dataset
// JSON-LD and per-fact "last verified" dates all follow facts.json.
import factsJson from '@data/facts/facts.json';
import sourcesJson from '@data/facts/sources.json';
import { factVerifiedDate, oldestDate, newestDate } from './fact-dates.mjs';

export interface ResolvedSource { name: string; url: string; accessed: string; tier?: number | null }
export interface ResolvedFact { id: string; text: string; sources: ResolvedSource[]; verified: string }

const FACTS: any[] = (factsJson as any).facts;
const SOURCES: Record<string, any> = (sourcesJson as any).sources;

export function resolveFact(id: string, must: string | string[]): ResolvedFact {
  const f = FACTS.find(x => x.id === id);
  if (!f) throw new Error(`[facts-stats] unknown fact id "${id}"`);
  if (f.status !== 'confirmed') throw new Error(`[facts-stats] fact "${id}" is "${f.status}", not confirmed - refusing to publish`);
  const text: string = String(f.value ?? f.claim);
  for (const m of Array.isArray(must) ? must : [must]) {
    if (!text.includes(m)) throw new Error(`[facts-stats] fact "${id}" does not contain "${m}" - displayed number would be unsupported`);
  }
  const fallbackDate: string = f.lastChecked || f.promotedOn || f.added || '';
  const sources: ResolvedSource[] = (f.sources ?? []).map((s: any) => {
    if (typeof s === 'string') {
      const reg = SOURCES[s];
      return reg?.url ? { name: reg.name, url: reg.url, accessed: fallbackDate, tier: reg.tier ?? null } : null;
    }
    return s?.url ? { name: s.name, url: s.url, accessed: s.accessed || fallbackDate, tier: s.tier ?? null } : null;
  }).filter(Boolean);
  if (sources.length === 0) throw new Error(`[facts-stats] fact "${id}" has no source URL`);
  const verified = factVerifiedDate(sources, fallbackDate);
  return { id, text, sources, verified };
}

export interface StatDef {
  label: string;      // what the number is
  display: string;    // the number as shown (must appear in fact text via `must`)
  context: string;    // unit / period / caveat
  factId: string;
  must: string | string[];
  chart?: { from: number; to: number };   // numeric range for the SVG chart
}
export interface StatGroup { id: string; heading: string; lead: string; stats: StatDef[]; chartUnit?: string }

export const STAT_GROUPS: StatGroup[] = [
  {
    id: 'wildebeest',
    heading: 'How many wildebeest take part in the Great Migration?',
    lead: 'Between 324,000 and 1.5 million, depending on the method. The long-standing aerial-survey estimate is 1.3 to 1.5 million; a 2025 Oxford satellite study counted far fewer.',
    chartUnit: 'wildebeest',
    stats: [
      { label: 'Traditional aerial-survey estimate', display: '1.3–1.5 million', context: 'Serengeti-Mara ecosystem, long-standing estimate', factId: 'wildebeest-migration-serengeti-population-1', must: '1.3 million to 1.5 million', chart: { from: 1_300_000, to: 1_500_000 } },
      { label: 'AI satellite count, August 2022', display: '324,202–337,926', context: 'University of Oxford, PNAS Nexus, 9 Sept 2025', factId: 'great-migration-annual-circuit-population-2', must: '324,202 to 337,926', chart: { from: 324_202, to: 337_926 } },
      { label: 'AI satellite count, August 2023', display: '502,917–533,137', context: 'University of Oxford, PNAS Nexus, 9 Sept 2025', factId: 'great-migration-annual-circuit-population-2', must: '502,917 to 533,137', chart: { from: 502_917, to: 533_137 } },
    ],
  },
  {
    id: 'whale-sharks',
    heading: 'How many whale sharks visit Mafia Island?',
    lead: 'The documented Mafia Island whale shark population more than doubled from about 100 in 2012 to 206 by December 2019, and 72% of research trips in the 2012-13 season saw at least one.',
    chartUnit: 'individual whale sharks',
    stats: [
      { label: 'Documented individuals, 2012', display: '~100', context: 'Mafia Island, Tanzania', factId: 'whale-sharks-mafia-operators-population-1', must: '100 individuals in 2012', chart: { from: 100, to: 100 } },
      { label: 'Documented individuals, December 2017', display: '180', context: 'Mafia Island, Tanzania', factId: 'whale-sharks-mafia-operators-population-1', must: '180 by December 2017', chart: { from: 180, to: 180 } },
      { label: 'Documented individuals, December 2019', display: '206', context: 'Mafia Island, Tanzania', factId: 'whale-sharks-mafia-operators-population-1', must: '206 individuals in December 2019', chart: { from: 206, to: 206 } },
      { label: 'Research trips that saw whale sharks', display: '72%', context: '103 trips, October 2012 to March 2013 (average 4.8 sharks per trip)', factId: 'whale-sharks-mafia-operators-probability-2', must: '72% of research trips' },
      { label: 'Average sharks seen per trip', display: '4.7', context: '338 trips, 2012 to 2018 (Marine Megafauna Foundation)', factId: 'whale-sharks-mafia-operators-probability-2', must: '4.7 individual sharks per trip over 338 trips' },
    ],
  },
  {
    id: 'populations',
    heading: 'How many lions, elephants, rhinos and gorillas live in East Africa?',
    lead: 'Counts differ by species and survey year; each row states its area and date. Mountain gorillas number 1,063 worldwide, and Kenya holds 1,059 black rhinos.',
    stats: [
      { label: 'Lions, Serengeti-Mara ecosystem', display: '3,000+', context: 'Estimate', factId: 'serengeti-lion-population', must: '3,000+ lions' },
      { label: 'Leopards, Serengeti ecosystem', display: '~1,000', context: 'Estimate', factId: 'african-leopard-serengeti-population-1', must: 'approximately 1,000' },
      { label: 'Elephants, Nyerere-Selous-Mikumi ecosystem', display: '20,006 ± 1,793', context: '2022 aerial census', factId: 'walking-safari-regulations-population-2', must: '20,006 ± 1,793' },
      { label: 'Black rhinos, Kenya', display: '1,059', context: 'By 2024', factId: 'black-rhino-east-africa-population-2', must: '1,059 individuals by 2024' },
      { label: 'Black rhinos, all of Africa', display: '6,487', context: 'End of 2022 (up 4.2% from 2021)', factId: 'black-rhino-east-africa-population-1', must: '6,487' },
      { label: 'Mountain gorillas, worldwide', display: '1,063', context: '2018 census, most recent comprehensive survey', factId: 'rwanda-gorilla-population', must: '1,063 individuals' },
      { label: 'African wild dogs, worldwide', display: '~6,600 adults', context: '39 subpopulations, 2020 assessment', factId: 'african-wild-dog-selous-population-2', must: '6,600 adults' },
      { label: 'Zanzibar red colobus, Unguja Island', display: '5,862', context: '342 groups, Oryx, December 2017', factId: 'zanzibar-red-colobus-population-1', must: '5,862 individuals' },
      { label: 'Bottlenose dolphins, Menai Bay', display: '136', context: '2002 mark-recapture estimate (95% CI 124-172)', factId: 'dolphins-menai-bay-population-1', must: '136 individuals' },
      { label: 'Large mammals, Ngorongoro Crater', display: '~25,000', context: 'Crater floor of 260 km²', factId: 'ngorongoro-crater-area', must: '25,000 large mammals' },
    ],
  },
  {
    id: 'costs',
    heading: 'How much does it cost to visit Tanzania and Zanzibar?',
    lead: 'Entry and park costs are fixed by government tariffs, in US dollars. Park fees below are the 2023/24 tariff period; confirm the current tariff with TANAPA before booking.',
    chartUnit: 'US$',
    stats: [
      { label: 'Tanzania tourist visa, EU and UK citizens', display: '$50', context: 'Single entry, up to 90 days', factId: 'tanzania-entry-entry-2', must: '$50 USD', chart: { from: 50, to: 50 } },
      { label: 'Tanzania tourist visa, US citizens', display: '$100', context: 'Multiple entry, valid one year', factId: 'tanzania-entry-entry-1', must: '$100 USD', chart: { from: 100, to: 100 } },
      { label: 'Zanzibar mandatory inbound insurance', display: '$44 adult / $22 child', context: 'Required since October 2024; free under 3', factId: 'znz-inbound-insurance', must: 'USD 44/adult, USD 22/child', chart: { from: 44, to: 44 } },
      { label: 'Mainland Tanzania inbound travel insurance', display: 'Required from 1 October 2026', context: 'Foreign visitors entering the Mainland, subject to exemptions; NIC is the designated insurer (GN 256 of 2026). Premium not yet officially confirmed, so not shown', factId: 'tanzania-mainland-inbound-insurance', must: 'From 1 October 2026' },
      { label: 'Zanzibar Marine Conservation Area entry', display: '$10 adult / $5 child', context: 'Non-East African visitors, from 1 September 2025', factId: 'zanzibar-reef-diving-detail-permit-2', must: '$10 per adult and $5 per child', chart: { from: 10, to: 10 } },
      { label: 'Serengeti and Nyerere conservation fee', display: '$70 per day', context: 'Per non-East African adult, 2023/24 tariff', factId: 'tanzania-park-fees-transfers-2', must: 'US$70 per person per day', chart: { from: 70, to: 70 } },
      { label: 'Ngorongoro Conservation Area fee', display: '$70.80 per day', context: 'Per non-East African adult, 2023/24 tariff', factId: 'tanzania-park-fees-transfers-2', must: 'US$70.80', chart: { from: 70.8, to: 70.8 } },
      { label: 'Ngorongoro Crater service fee', display: '~$295 per vehicle', context: 'Per vehicle, not per person, for crater descent', factId: 'tanzania-park-fees-transfers-3', must: 'US$295 per vehicle', chart: { from: 295, to: 295 } },
    ],
  },
];

export interface ResolvedStat extends StatDef { fact: ResolvedFact; groupId: string; groupHeading: string }

export function resolvedGroups() {
  return STAT_GROUPS.map(g => ({
    ...g,
    stats: g.stats.map(s => ({ ...s, fact: resolveFact(s.factId, s.must), groupId: g.id, groupHeading: g.heading }) as ResolvedStat),
  }));
}

const allVerified = () => resolvedGroups().flatMap(g => g.stats.map(s => s.fact.verified));
// There is deliberately no single "last verified" label for the whole page: a global label hides stale rows.
// firstVerified() = the OLDEST per-fact date (what the page headline and the freshness gate use);
// lastVerified() = the newest, only for dateModified metadata.
export function lastVerified(): string { return newestDate(allVerified()); }
export function firstVerified(): string { return oldestDate(allVerified()); }

export function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function statsCsv(): string {
  const head = ['section', 'statistic', 'value', 'context', 'fact_id', 'source_names', 'source_urls', 'last_verified'];
  const rows = resolvedGroups().flatMap(g => g.stats.map(s => [
    g.heading, s.label, s.display, s.context, s.fact.id,
    s.fact.sources.map(x => x.name).join(' | '), s.fact.sources.map(x => x.url).join(' | '), s.fact.verified,
  ]));
  return [head, ...rows].map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}

// ---- Seasonal windows for the migration calendar (same guard rails) ----
export interface WindowDef { event: string; where: string; window: string; peak: string; factId: string; must: string | string[] }
export const SEASON_WINDOWS: WindowDef[] = [
  { event: 'Wildebeest calving', where: 'Southern Serengeti and Ndutu', window: 'December–March', peak: 'February', factId: 'great-migration-annual-circuit-season-1', must: 'December to March' },
  { event: 'Grumeti River crossings', where: 'Serengeti Western Corridor', window: 'Late May–August', peak: 'June–July', factId: 'grumeti-migration-timing', must: 'late May to August' },
  { event: 'Mara River crossings', where: 'Northern Serengeti and Masai Mara', window: 'July–October', peak: 'August–September', factId: 'great-migration-annual-circuit-season-2', must: 'July to October' },
  { event: 'Herds in the Masai Mara', where: 'Masai Mara, Kenya', window: 'Late July–October', peak: 'August–September', factId: 'mara-migration-timing', must: 'late July' },
  { event: 'Whale shark season', where: 'Mafia Island', window: 'October–February', peak: 'November–January', factId: 'whale-shark-mafia-season', must: 'October to February' },
  { event: 'Humpback whale passage', where: 'Tanzanian coast and Zanzibar', window: 'July–October', peak: 'July–September', factId: 'humpback-whale-tanzanian-coast', must: 'Jul-Oct (peak Jul-Sep)' },
];
export function resolvedWindows() {
  return SEASON_WINDOWS.map(w => ({ ...w, fact: resolveFact(w.factId, w.must) }));
}

// ---- Counts that appear in marketing copy: derived, never hand-typed ----
export function factCounts() {
  return {
    total: FACTS.length,
    confirmed: FACTS.filter(f => f.status === 'confirmed').length,
  };
}
