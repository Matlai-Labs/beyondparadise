// voice-lint — does this text read like a machine wrote it?
//
// The Content Voice & Style Guide (shared_knowledge/docs/content-voice-style-guide-playbook.md)
// has carried a complete anti-AI-tell ban-list since June. It is good, and it was never enforced,
// because a rule that lives only in prose has to be REMEMBERED. This turns §3 into something the
// machine applies at the moment text is produced.
//
// Deterministic on purpose: no model call, no API key, no cost, no latency, same answer every
// time. That is what lets it sit in a pre-commit hook or a publish gate without anyone thinking
// about budget — and this fleet's hardest rule is cost discipline.
//
// It measures what is measurable and refuses to guess at the rest.
//
// IMPORTANT — what burstiness is and is not (researched 2026-08-17, correcting the first draft
// of this file). Burstiness is the standard deviation of sentence word-count. It is NOT a
// reliable signal of machine authorship: peer-reviewed work shows perplexity/burstiness cannot
// separate human from AI text at an acceptable false-positive rate, the gap shrinks as models
// improve, and plain human writing (textbook and reference prose especially) scores "AI-like".
// Anyone selling burstiness as an AI DETECTOR is overselling it.
//
// It is kept here because this is a STYLE linter, not a detector, and for that job it is sound:
// "do these sentences all run the same length?" is exactly what §2 of the playbook forbids
// ("AI's biggest tell is uniform medium-length sentences. Break it."). Monotonous rhythm is bad
// prose whoever produced it. So the check stays and stays an error — the justification is
// readability, not provenance. Never report a burstiness score as evidence that something "is AI".
//
// "Does this carry a real opinion?" is not measurable, so it is left to the human/model rewrite
// passes in §9 rather than faked with a regex.
//
//   node voice-lint.mjs <file>              lint a file
//   cat draft.md | node voice-lint.mjs -    lint stdin
//   node voice-lint.mjs <file> --json       machine-readable
//   node voice-lint.mjs <file> --quiet      exit code only
//
// Exit 0 = publishable, 1 = tells found, 2 = usage error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));

const WORD = /[A-Za-z0-9']+/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A URL is an address, not prose: the words in a slug were chosen by whoever named the page
// (often years ago, on another platform) and cannot be "rewritten" without breaking a link.
// A page link written as a root-relative path, e.g. /post/some-page-title, was missed by the
// old https-only mask, so commits touching those pages failed on a word in the slug and were
// made with the linter skipped, switching the whole
// check off. Masked now: absolute URLs, protocol-relative //host/…, www.host…, and
// site-root paths /a/b-c. A slash after a letter or digit ("24/7", "and/or") is not a path.
// Kept identical in voice_lint.py; voice-lint.test.mjs checks both.
export const URL_PATTERNS = [
  /https?:\/\/\S+/g,
  /(?<![\w:/])\/\/[^\s/]+\.[^\s/]+\S*/g,
  /(?<![\w/.])www\.[^\s/]+\.\S+/g,
  /(?<![\w/:.\\])\/[A-Za-z0-9%~._-]+(?:\/[A-Za-z0-9%~._-]+)*\/?/g,
];

/** Strip fenced code, inline code, URLs and quoted spans — §3c: quotes and proper names are exempt. */
function maskExempt(text) {
  const blank = (m) => ' '.repeat(m.length);
  let t = text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`]*`/g, blank);
  for (const re of URL_PATTERNS) t = t.replace(re, blank);
  return t
    .replace(/\u201c[^\u201c\u201d]{0,400}\u201d/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]{0,400}"/g, (m) => ' '.repeat(m.length));
}

export function sentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'\u201c])/)
    .map((s) => s.trim())
    .filter((s) => (s.match(WORD) || []).length > 0);
}

export function paragraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Standard deviation of sentence word-counts. Uniform length is the biggest single AI tell. */
export function burstiness(text) {
  const lens = sentences(text).map((s) => (s.match(WORD) || []).length);
  if (lens.length < 2) return { value: 0, sentences: lens.length, mean: lens[0] ?? 0 };
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return { value: Math.sqrt(variance), sentences: lens.length, mean };
}

function findPhrases(masked, list, category, severity) {
  const out = [];
  for (const phrase of list) {
    const re = new RegExp(`\\b${phrase.split(' ').map(esc).join('\\s+')}\\b`, 'gi');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const before = masked.slice(0, m.index);
      out.push({
        type: category, severity, phrase,
        line: before.split('\n').length,
        match: m[0],
      });
      if (out.length > 200) return out;
    }
  }
  return out;
}

// ---- 2026-10-11 structure checks (no-ai-slop gap closure). WARN ONLY, run on masked text, and only
// on copy of >= structureChecksMinWords words. Kept identical in voice_lint.py (parity-tested).
// Apostrophes are normalised first so curly quotes do not hide a match.
// Decorative emoji only. Status marks (check, cross, warning, ballot box, heavy check) are excluded:
// internal docs use them as labels, not decoration.
const EMOJI = '\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{2610}\\u{2612}-\\u{269F}\\u{26A1}-\\u{26FF}\\u{2700}-\\u{2704}\\u{2706}-\\u{2712}\\u{2719}-\\u{274B}\\u{274D}-\\u{27BF}\\u{2B50}\\u{2B55}';
// A fragment's last word must not be an abbreviation (vs. etc. St. Dr. No.) or an initial / e.g. / i.e. letter.
const ABBR = 'vs|Vs|etc|St|Dr|Mr|Mrs|Ms|Mt|No|Nr|Jr|Sr|Prof|approx|cf|incl|Inc|Ltd|Co|Ave|Rd|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const CAP = `(?:[A-Za-z']+[ \\t]){0,2}(?!(?:[A-Za-z]|${ABBR})\\.)[A-Za-z']+[.!?]`;
export const STRUCTURE_PATTERNS = {
  binaryContrast: [
    /\bnot[ \t]+(?:just|only|merely)[ \t]+[^.!?\n]{1,60}?\bbut\b/gi,
    /\b(?:isn't|is not|wasn't|was not|aren't|are not)[ \t]+(?:just|only|merely|about)[ \t]+[^.!?\n]{1,60}[.;,][ \t]+(?:it's|it is|they're|they are|that's|but)\b/gi,
    /\b(?:it's|it is|this is|that's|that is)[ \t]+not[ \t]+(?:just[ \t]+|only[ \t]+|about[ \t]+)?[^.!?\n]{1,60}[.;,][ \t]+(?:it's|it is|but)\b/gi,
  ],
  negativeListing: [/\bNot an?[ \t][^.!?\n]{1,40}\.[ \t]+Not an?[ \t][^.!?\n]{1,40}\.[ \t]+An?[ \t]/g],
  superficialIng: [/,[ \t]+(?:highlighting|underscoring|showcasing|emphasi[sz]ing|cementing)[ \t]/gi],
  colonReveal: [/(?:^|[.!?][ \t]+)(?:The|Here's|Here is|Why|One|Bottom|Big)(?:[ \t]+[A-Za-z']+){0,3}:[ \t]+(?:it|you|we|they|that|this|there|nothing|everything|nobody|no)\b[^.!?\n:]{3,80}[.!?]/gm],
  dramaticFragments: [new RegExp(`(?:^|[.!?][ \\t]+)${CAP}[ \\t]+${CAP}[ \\t]+${CAP}`, 'gm')],
  emojiHeading: [new RegExp(`^#{1,6}[ \\t].*[${EMOJI}]`, 'gmu')],
};

function structureFindings(masked, limit) {
  const norm = masked.replace(/[\u2018\u2019]/g, "'");
  const out = [];
  for (const [type, res] of Object.entries(STRUCTURE_PATTERNS)) {
    let n = 0;
    for (const re of res) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(norm)) !== null && n < limit) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const lead = m[0].match(/^[.!?][ \t]+/);
        const at = m.index + (lead ? lead[0].length : 0);
        out.push({ type, severity: 'warn', line: norm.slice(0, at).split('\n').length, match: m[0].trim().replace(/\s+/g, ' ').slice(0, 90) });
        n++;
      }
    }
  }
  return out;
}

export function lint(text, rules = RULES) {
  const masked = maskExempt(text);
  const words = (text.match(WORD) || []).length;
  const per100 = (n) => (words ? (n / words) * 100 : 0);
  const findings = [];

  findings.push(...findPhrases(masked, rules.phrases.cliche, 'cliche', 'error'));
  findings.push(...findPhrases(masked, rules.phrases.hedge, 'hedge', 'error'));
  findings.push(...findPhrases(masked, rules.phrases.windup, 'windup', 'error'));
  // Fake transitions are only a tell when they OPEN a sentence on autopilot.
  for (const t of rules.phrases.fakeTransition) {
    const re = new RegExp(`(^|[.!?]\\s+|\\n)\\s*${esc(t)}\\b`, 'gi');
    let m;
    while ((m = re.exec(masked)) !== null) {
      findings.push({ type: 'fakeTransition', severity: 'error', phrase: t, line: masked.slice(0, m.index).split('\n').length, match: t });
    }
  }
  // Self-descriptions that deny being an AI — a product rule, not a style one.
  findings.push(...findPhrases(text.toLowerCase(), rules.disclosure.bannedSelfDescriptions, 'falseHumanClaim', 'blocker'));

  // 2026-10-11 warn-only layers. Apostrophes normalised so "it's" matches "it’s".
  const norm = masked.replace(/[\u2018\u2019]/g, "'");
  const P = rules.phrases;
  findings.push(...findPhrases(norm, P.corporateWord || [], 'corporateWord', 'warn'));
  findings.push(...findPhrases(norm, P.emptyPhrase || [], 'emptyPhrase', 'warn'));
  findings.push(...findPhrases(norm, P.weaselAttribution || [], 'weaselAttribution', 'warn'));
  for (const t of P.recapOpener || []) {
    // Paragraph-opening only: "Ultimately, we walked." mid-paragraph is narrative, not a recap.
    const re = new RegExp(`(^|\\n[ \\t]*\\n)[ \\t]*${esc(t)}${t.endsWith(',') ? '' : '\\b'}`, 'gi');
    let m;
    while ((m = re.exec(norm)) !== null) {
      findings.push({ type: 'recapOpener', severity: 'warn', phrase: t, line: norm.slice(0, m.index).split('\n').length, match: t });
    }
  }

  const b = burstiness(text);
  const s = rules.structure;
  if (words >= (s.structureChecksMinWords ?? 80)) findings.push(...structureFindings(masked, s.maxStructureHitsPerCheck ?? 20));
  if (b.sentences >= s.minSentences && b.value < s.minBurstiness) {
    findings.push({
      // A readability failure, not a claim about who wrote it. See the header note.
      // Short honest copy (an 86-word spa paragraph measured sd 3.98) must not be blocked: error only at length.
      type: 'uniformSentences', severity: words >= (s.uniformSentencesErrorMinWords ?? 0) ? 'error' : 'warn', line: 1,
      match: `sentence length barely varies: sd ${b.value.toFixed(1)} < ${s.minBurstiness} over ${b.sentences} sentences (mean ${b.mean.toFixed(1)} words)`,
    });
  }

  const tricolons = (masked.match(/\b[\w'-]+,\s+[\w'-]+(?:\s+[\w'-]+)?,\s+and\s+[\w'-]+/gi) || []).length;
  if (per100(tricolons) > s.maxTricolonPer100Words) {
    findings.push({ type: 'ruleOfThree', severity: 'warn', line: 1, match: `${tricolons} triads in ${words} words` });
  }

  const emDashes = (masked.match(/—/g) || []).length;
  if (per100(emDashes) > s.maxEmDashPer100Words) {
    findings.push({ type: 'emDashOveruse', severity: 'warn', line: 1, match: `${emDashes} em-dashes in ${words} words` });
  }

  const crutches = (s.crutchWords || []).reduce((n, w) => n + (masked.match(new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu')) || []).length, 0);
  if (s.maxCrutchPer1000Words != null && words > 0 && (crutches * 1000) / words > s.maxCrutchPer1000Words) {
    findings.push({ type: 'crutchWords', severity: 'warn', line: 1, match: `${crutches} honesty/emphasis crutches ("genuinely", "honest", "ehrlich"…) in ${words} words` });
  }

  const paras = paragraphs(text).filter((p) => !p.startsWith('#') && !p.startsWith('|'));
  if (paras.length >= 4) {
    const counts = paras.map((p) => sentences(p).length);
    // copy before sort/pop: the old in-place pop() dropped one paragraph from `counts`, skewing the ratio.
    const mode = [...counts].sort((a, b) => counts.filter((x) => x === a).length - counts.filter((x) => x === b).length).pop();
    const near = counts.filter((c) => Math.abs(c - mode) <= s.uniformParagraphToleranceSentences).length;
    if (near / counts.length > s.maxUniformParagraphRatio) {
      findings.push({ type: 'uniformParagraphs', severity: 'warn', line: 1, match: `${near}/${counts.length} paragraphs are ${mode}±${s.uniformParagraphToleranceSentences} sentences` });
    }
  }

  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  return {
    ok: blockers === 0 && errors === 0,
    words, burstiness: Number(b.value.toFixed(2)), sentences: b.sentences,
    counts: { blockers, errors, warns },
    findings: findings.sort((a, b2) => a.line - b2.line),
  };
}

// Playbook §9c: five ready-to-paste rewrite prompts, one per finding cluster. Not a bypass —
// running a prompt does not change what gets re-checked; it just tells you which pass to run.
const PROMPT = {
  cliche: 'AI Phrase Killer', hedge: 'AI Phrase Killer', windup: 'AI Phrase Killer', fakeTransition: 'AI Phrase Killer',
  uniformSentences: 'Pattern Disruptor', ruleOfThree: 'Pattern Disruptor', emDashOveruse: 'Pattern Disruptor', uniformParagraphs: 'Pattern Disruptor',
  corporateWord: 'AI Phrase Killer', emptyPhrase: 'AI Phrase Killer', weaselAttribution: 'AI Phrase Killer', recapOpener: 'AI Phrase Killer',
  binaryContrast: 'Pattern Disruptor', negativeListing: 'Pattern Disruptor', superficialIng: 'Pattern Disruptor', colonReveal: 'Pattern Disruptor', dramaticFragments: 'Pattern Disruptor',
};

const HINT = {
  cliche: 'brochure language — replace with the specific detail only someone present would know',
  hedge: 'hedging filler — delete it and state the thing',
  windup: 'empty windup — open with the answer, a number, or a take',
  fakeTransition: 'autopilot transition — cut it or make the link real',
  uniformSentences: 'monotonous rhythm — follow a long sentence with a short one (readability, not an AI verdict)',
  ruleOfThree: 'constant triads are an AI rhythm — break the pattern',
  emDashOveruse: 'leaning on dashes for all rhythm — vary the punctuation',
  uniformParagraphs: 'identical paragraph shapes — use a one-line paragraph for the key take',
  corporateWord: 'corporate buzzword (advisory) — say the plain thing',
  emptyPhrase: 'throat-clearing or puffery (advisory) — open with the fact',
  weaselAttribution: 'unsourced authority (advisory) — name the source or cut it',
  recapOpener: 'recap opener (advisory) — end on the last real point',
  binaryContrast: 'not-X-but-Y frame (advisory) — state the positive claim directly',
  negativeListing: 'negative listing (advisory) — say what it is',
  superficialIng: 'trailing -ing clause (advisory) — say what the thing does, not what it "highlights"',
  colonReveal: 'teaser-colon reveal (advisory) — a plain sentence; colons for labels and lists',
  dramaticFragments: 'three fragments in a row (advisory) — use complete sentences',
  emojiHeading: 'emoji in a heading (advisory) — plain heading text',
  falseHumanClaim: 'BLOCKER: never claim to be human. Sounding human is craft; denying you are an AI is deception.',
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: voice-lint.mjs <file|-> [--json] [--quiet]'); process.exit(2); }
  const text = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
  const res = lint(text);
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(res.ok ? 0 : 1); }
  if (!args.includes('--quiet')) {
    const label = target === '-' ? 'stdin' : target;
    if (res.ok && !res.counts.warns) {
      console.log(`voice-lint: ${label} — clean (${res.words} words, burstiness ${res.burstiness})`);
    } else {
      console.log(`voice-lint: ${label} — ${res.counts.blockers} blocker, ${res.counts.errors} error, ${res.counts.warns} warn (${res.words} words, burstiness ${res.burstiness})`);
      for (const f of res.findings.slice(0, 40)) {
        console.log(`  L${String(f.line).padStart(4)}  ${f.severity.padEnd(7)} ${f.type.padEnd(18)} ${f.match}`);
        if (HINT[f.type]) console.log(`         ${HINT[f.type]}`);
        if (PROMPT[f.type]) console.log(`         fix with the "${PROMPT[f.type]}" prompt — playbook §9c`);
      }
      if (res.findings.length > 40) console.log(`  … ${res.findings.length - 40} more`);
      const prompts = [...new Set(res.findings.filter((f) => PROMPT[f.type]).map((f) => PROMPT[f.type]))];
      if (prompts.length) console.log(`\n  Rewrite with: ${prompts.join(', ')} (shared_knowledge/docs/content-voice-style-guide-playbook.md §9c)`);
    }
  }
  process.exit(res.ok ? 0 : 1);
}
