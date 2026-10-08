# seo-gates - shared SEO / AI-visibility gates

Dependency-free (Node >= 20, ESM, `node:test`), deterministic, **zero network, no credentials, no paid calls**. Copy the folder into any
static-site repo (`cp -R shared_knowledge/scripts/seo-gates <site>/scripts/seo-gates`) - products never import Agent OS or shared_knowledge at runtime.
Born from the 2026-10-08 SEO/AI audit. Test: `node --test tests/*.test.mjs`.

Exit codes (all tools): `0` clean (warnings allowed) - `1` findings that fail the gate - `2` usage error. `--strict` makes warnings fail too. `--json` for machines.

| Tool | What it does | Command |
|---|---|---|
| **click-depth** | BFS from `/` over built HTML: pages deeper than `--max-depth` (default 3), orphans (0 inlinks), unreachable pages. Ignores noindex + redirect stubs; `--allow` globs; sites with no `/` page start from `/en`,`/de`... (`--root`). | `node click-depth.mjs dist --max-depth 3` |
| **title-gate** | `<title>` (and markdown `title:` with `--md`): >60/<30 chars = error, >55 warns; AI-style phrasing (Ultimate Guide, Comprehensive, Everything you need to know, Honest, Complete Guide, `: A `, "Which X is better", over-punctuation, `?`+`:`; de/fr/it/es/pl equivalents); no keyword shared with slug/H1; duplicates (error) and near-duplicates Jaccard>=0.5 (warn, cannibalisation) per language. `--limits limits.json` per-language, `--allow allow.json`. | `node title-gate.mjs dist --limits limits.example.json` |
| **stale-page** | "Last updated"/`dateModified`/frontmatter `updated` older than `--max-age` (180) days; past seasons ("2024/25"), past years in future tense, "starts on <past date>". | `node stale-page.mjs dist --today 2026-10-08` |
| **claim-clock** (invention) | `claims.json` registry of time-bound facts (valid_from/until, status announced/operating/ended, sources). Scans md/json/html/astro/txt, multilingual (en/de/fr/it/es/pl): present-tense wording about something not yet operating = **ERROR** with file:line, sentence, rule, suggested safe wording; ended periods = WARN; announced facts without a date = WARN. `--today` injectable. `--flips` = "what changed status today": claims now operating / ended / flipping in 45 days / unverified. | `node claim-clock.mjs dist src --today 2026-10-08` / `node claim-clock.mjs --flips` |
| **cluster-rollup** | Roll a GSC page export (+ Search-Console generative-AI CSV + GA4 AI-assistant sessions) up to content clusters with period-over-period delta; markdown + JSON. Accepts shared `match` globs or the engine's `pillar/spokes` format. | `node cluster-rollup.mjs --clusters defs.json --gsc cur.csv --gsc-prev prev.csv --ai ai.csv --out out/` |
| **fanout-coverage** (invention 2) | For each hub, which sub-questions are answered by an H2/H3/`<summary>`/FAQPage question on the hub or its spokes (keyword + synonym, no embeddings) -> gap table. Seed: `fanout/matlai-site.json` (8 hubs, 44 questions; includes halal, dietary, cancellation, weather, money, Ramadan). | `node fanout-coverage.mjs dist fanout/matlai-site.json` |
| **ga4-ai-assistants/** | GA4 custom channel group "AI Assistants" (regex + exact UI steps), GTM Custom-HTML snippet pushing `ai_source`, Node classifier. | see `ga4-ai-assistants/README.md` |

## Adopting in a site

1. Vendor the folder (above). 2. `node --test tests/*.test.mjs`. 3. Add scripts to the site's `package.json`:
`"seo:gates": "node scripts/seo-gates/claim-clock.mjs dist src && node scripts/seo-gates/title-gate.mjs dist && node scripts/seo-gates/click-depth.mjs dist"`.
4. Run after `build` in CI / pre-deploy; run `claim-clock.mjs --flips` monthly (cron/launchd) - and add a claim to `claims.json` whenever copy depends on a start/end date.
5. Start in report mode (`|| true`) on a site with existing debt, then ratchet: fix, then drop the `|| true`. Deliberate exceptions go in an allow file - never loosen the rule.
Site-specific: `ADOPT-matlai-site.patch.md` (dashboard wiring), `limits.example.json`, `allow.example.json`.

### Pre-commit / CI

```bash
# .git/hooks/pre-commit  (fast: claim-clock on changed content only)
git diff --cached --name-only --diff-filter=ACM | grep -E '\.(md|mdx|json|astro|html)$' | xargs -r node scripts/seo-gates/claim-clock.mjs
# CI after build
npm run build && node scripts/seo-gates/claim-clock.mjs dist src && node scripts/seo-gates/title-gate.mjs dist && node scripts/seo-gates/click-depth.mjs dist
```

## Design notes / limits (read before trusting a green run)

* HTML parsing is regex-based (no DOM): fine for generated static output, not for arbitrary hand-written HTML.
* Relative links resolve against the page path as a directory (index.html / trailingSlash builds).
* claim-clock is a **sentence-level heuristic**: operating wording + subject + object, hedged by future words or dates. It catches the 3 known incident
  shapes and their translations; it does not understand negation ("does not fly") beyond the past/ended list. Treat ERRORs as "a human must look", and
  expect some warnings on historical prose.
* The registry's dates are only as good as their `sources`; `brussels-bru-znz` is deliberately `verify:true` (unverified). Re-verify before flipping any status.
* `lib/gsc.mjs#parseGenerativeAiCsv` is a port of `SEO_and_AI_Performance_Program/backend/app/services/gsc/generative_ai_import.py` (same rules); the Matlai SEO engine has its own CJS copy
  (`matlai_wix/matlai-seo-engine/src/core/gscGenerativeAiImport.js`). Change both together.
