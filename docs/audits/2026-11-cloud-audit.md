# Cloud audit — beyondparadiseadventures — 2026-11 sprint (report only)

Run date: 2026-10-31 · Base: `main` @ `85930fd` · Auditor: scheduled cloud run (read-only; no deploy, no PR, no paid API, no posts, no secrets printed).

## Status
- Site live on GitHub Pages (per CLAUDE.md); deploy is manual (`site/deploy.sh`), no CI exists (`.github/` absent), so nothing guards `main`.
- Last commits (Oct 2026): social reel QA gate, IG draft score, SEO gates, author-claims cleanup. Work is healthy and recent.
- Working tree clean at start. `social/queue.json`, `cards/`, `reels/`, `.env` are gitignored; no tracked secrets found (regex scan for key/token/password literals: 0 hits; only `.env.example` tracked).

## Verification
| Check | Result |
|---|---|
| `cd social && node --test lib.test.js` | **PASS** 9/9 (0 fail) |
| `site`: `npm ci` + `npm run build` (unit tests, shared-facts check, astro build, content-gate, check-links, seo-gates) | **PASS** exit 0. check-links PASS (0 orphans, max depth 2). seo-gates: title/claim-clock/click-depth pass; stale-page = warn, data-freshness = warn |
| Not run | `social/score.test.js`, `reel-qa.test.js` (not requested); social runtime (needs Tim's Mac paths, Meta tokens, WhatsApp bridge) |

Build warnings worth acting on: `/intelligence/east-africa-tourism-stats/` cites the 2023/24 park-fee tariff and 2022-23 period (claim-clock/stale-page); `stats-page-quarterly` refresh was due 2026-09 and is overdue.

## Findings
Sev: H high · M medium · L low. Line numbers are from `main` @ `85930fd`.

| # | Sev | file:line | Problem | Fix | Effort | Needs Tim? |
|---|---|---|---|---|---|---|
| 1 | H | `social/approval-server.js:33-43` | The approval endpoint `POST /bpa/action` has no authentication (127.0.0.1 only). Any local process, or any browser page via DNS-rebinding/CSRF to `localhost:3028`, can send `bpa approve B1` / `bpa post B1 now` and publish to the Facebook Page and Instagram. This undermines the "nothing posts without explicit approve" rule. | Require a shared-secret header (`BPA_APPROVAL_TOKEN`, also set in the bridge), reject non-`application/json` and any `Host` other than `127.0.0.1:3028`/`localhost:3028`. | S | Token value + bridge config (Tim). Code/tests: no |
| 2 | H | `social/worker.js:4,27` and `social/approval-server.js:21-23,43` | Lost-update race. `worker.js` loads the queue at start and rewrites the whole file at end. An IG reel render can take minutes (`video.js:71` timeout 600 s). A `bpa skip/approve/edit` saved by the approval server in that window is overwritten (e.g. a skipped draft returns to pending, a scheduled one loses `postId`). `saveQueue` is atomic but not merge-safe. | Re-load queue immediately before save and merge per-draft, or add a lockfile (`queue.lock`) shared by worker and server. | M | No |
| 3 | H | `social/worker.js:12-14` | No in-progress marker for IG publish. Worker runs every 15 min; a run that exceeds 15 min (render up to 600 s + upload + 3 min poll) overlaps the next run, and both see `d.ig.status==='queued'` and call `media_publish`, duplicating the Reel. Also a crash after `media_publish` but before `saveQueue` re-publishes next tick. | Set `d.ig.status='publishing'` and `saveQueue` before calling `igPostDraftAny`; add the lock from #2. | S | No |
| 4 | M | `pipeline/research/research-providers.js:35,72` vs `:121,153,226,254,277,300` | The spend guard (`checkAffordable`/`record`) wraps only Gemini grounded and Perplexity. Tavily, Brave, OpenRouter, DeepSeek, OpenAI and Anthropic fallbacks are called with no per-run/day cap and no kill-switch check. CLAUDE.md requires a hard fail-closed ≤€20/month cap across all pipelines. If Gemini is skipped/exhausted the cascade spends uncapped. | Call a `guard.checkAffordable`/`record` (separate counters per provider, plus the `.research-kill` check) at the top of every `call*` function; add a monthly € ledger. | M | Cap values (Tim) |
| 5 | M | `social/video.js:21,50` | Render loads `gsap@3` (floating major) from jsDelivr and Google Fonts at render time. A compromised/changed CDN asset runs inside headless Chrome on Tim's Mac, and offline renders fail. | Pin exact version (`gsap@3.12.x`) with SRI, or vendor gsap/fonts into `social/assets/`. | S | No |
| 6 | M | `social/lib.js:12-13,173,192` | Hard-coded absolute Mac paths (`/Users/tim/...`) incl. reading `Padel_Revive/.env` WordPress creds to upload Instagram media to an unrelated brand's domain (padelrevive.com). `wpCreds()` crashes the whole publish if missing, and it couples BPA's published media to another brand's site (editorial-independence/brand hygiene). | Move paths to env vars with explicit failure; host media on a BPA-owned location (e.g. a `gh-pages` media path or Cloudflare R2). | M | Yes (hosting decision) |
| 7 | M | `social/config.json:28` vs `social/README.md:15` | Docs say `includeLinks:false`; config is `true`. `brandGuard` (`lib.js:89`) link check is therefore inactive, README is stale. Test `lib.test.js:15-17` branches around it so the mismatch is not caught. | Decide intended value; update README or config; make test assert the documented value. | S | Confirm intent |
| 8 | M | `social/lib.js:54-66,75-85` | Auto-drafted public copy makes first-person, unsourced assertions in Tim's voice: "Confidence N% from X independent sources. I publish only what clears the bar." and "what my intelligence engine reads from public data every morning". N and X come from BPI JSON that is not checked against `data/facts/` (CLAUDE.md rule 2/4: every number needs ≥2 sources in the DB; `[TIM]` claims need date and observation). Approval gate is the only control. | Add a gate: reject drafts whose `sources.length<2`; drop the "Confidence …%" line or tie it to BPI source IDs; remove "every morning" unless the cron is verified. | S | Tim to approve wording |
| 9 | M | `social/video.js:49` (`.sub` text) | Reel footer hard-codes "Daily tourism intelligence for Zanzibar & Dar es Salaam" — a published brand claim that sits outside the positioning in CLAUDE.md (East Africa + Vietnam marine/lodge editorial) and is unverified ("daily"). | Make the tagline a config value matching approved positioning. | S | Yes (wording) |
| 10 | L | `social/lib.js:14` | Personal phone number committed as default `WHATSAPP_ALERT_TO` (PII in repo). | Require env var; fail closed if unset. | S | No |
| 11 | L | `social/lib.js:123-132` | `nextSlots` derives the date with `toISOString()` (UTC) but labels the slot `+03:00`; a run between 00:00-03:00 EAT can pick a day already taken or skip one. | Compute day in `CONFIG.timezone`. | S | No |
| 12 | L | `social/lib.js:137` (`postStatus`) | Meta access token is placed in the URL query string (`access_token=`), so it appears in any proxy/error log. Same in `igPublish*` polling (`:204,221`). | Send as `Authorization: Bearer` header / POST body. | S | No |
| 13 | L | `site/` build output | `/intelligence/east-africa-tourism-stats/` shows 2023/24 park-fee tariff (claim-clock `stale-period`, `stale-rate-year`); quarterly refresh overdue since 2026-09 (`data-freshness`). | Run the research pipeline refresh for the stats facts; or label as "last published tariff" per decision in `docs/site-ops-seo-ai.md`. | M | Fact review (Tim) |
| 14 | L | `deploy.sh`, repo root | No CI: `main` has no automated build/test; `social` tests and `site` build only run if someone remembers. Deploy force-pushes `gh-pages` from a local machine. | Add `.github/workflows/ci.yml` running `social` tests and `site` build on PRs (no deploy step). | S | No |
| 15 | L | `CLAUDE.md` (Phase roadmap, research status) | Stale backlog: roadmap says domain "NOT reachable as of 2026-08-02" while Tech-stack says LIVE since 2026-09-14; research status is dated 2026-07-01 (813 facts, queue 5). Open items in `docs/site-ops-seo-ai.md` (Beehiiv, GSC, Bing, GA4, CF analytics tokens, NIC insurance fact) still pending since 2026-10-08. | Reconcile roadmap; re-run `kb-status.js`; close or restate open items. | S | Tim for env tokens |
| 16 | L | `data/facts/sources.json:266` | Source note says "Beyond Paradise Asia correspondent" (short brand form; internal data, not rendered — verify before rendering). | Change to full brand name. | S | No |

### Checked, no issue found
- Voice and brand gates fail closed (`lib.js:93-97`, `:87-92`); `edit` re-runs both gates (`approval-server.js:16`); drafts expire after 7 days (`worker.js:9`).
- Bridge/approval bind to 127.0.0.1 only; request body capped at 20 kB.
- Posting needs an explicit command: no code path publishes a `pending_approval` draft (`draft.js` only queues + messages). Issue #1 is the one bypass.
- No secrets tracked; `.env` ignored; build gates verify titles, links, orphans, fact dates.

## Top 5 fixes doable without secrets (with acceptance tests)

1. **Lock + merge-safe queue writes (findings 2, 3).**
   Add `withQueueLock(fn)` in `social/lib.js` (lockfile with stale-timeout) used by `worker.js` and `approval-server.js`; set `d.ig.status='publishing'` and save before `igPostDraftAny`.
   *Accept:* new test in `lib.test.js` — (a) two concurrent `withQueueLock` calls run serially; (b) simulate worker snapshot, server marks B1 `skipped`, worker saves → B1 stays `skipped`; (c) a draft with `ig.status='publishing'` is not republished. `node --test lib.test.js` passes.

2. **Authenticate the approval endpoint (finding 1) — code only, token read from env.**
   Reject requests without `x-bpa-token` equal to `process.env.BPA_APPROVAL_TOKEN` (fail closed if unset), and bad `Host`. Export `authorize(req, env)` for testing.
   *Accept:* unit tests — missing/wrong token → 401, wrong Host → 403, correct token + Host → allowed; with env unset, every action returns 503.

3. **Extend the spend guard to every paid/cascade provider (finding 4).**
   Add `guard.checkAffordable('provider')`/`record` to Tavily, Brave, OpenRouter, DeepSeek, OpenAI, Anthropic calls with per-provider daily caps and kill-switch.
   *Accept:* test with stubbed `axios`: with `.research-kill` present, each `call*` throws `SPEND GUARD` and makes 0 HTTP requests; with cap=1, second call throws; `node pipeline/research/research-daily.js --dry` still runs.

4. **Pin/vendor render assets and remove PII default (findings 5, 10, 12).**
   Pin gsap with exact version, remove the hard-coded phone default (require env, fail closed), move tokens from URLs to headers.
   *Accept:* `grep -n "gsap@3/" social/video.js` → none (exact version or local file); `grep -rn "+255" social/` → none; test that `whatsapp()` returns false and logs when `WHATSAPP_ALERT_TO` unset; `buildComposition` test asserts no unpinned CDN URL.

5. **Draft-copy claim gate and config/doc reconciliation (findings 7, 8, 11, 14).**
   `brandGuard`/`buildDrafts` reject signal drafts with <2 sources; fix `nextSlots` to use `CONFIG.timezone`; reconcile README vs `includeLinks`; add `.github/workflows/ci.yml` (tests + `npm run build`, no deploy).
   *Accept:* tests — draft with 1 source is `rejected`; `nextSlots` at `2026-11-02T22:30Z` returns 2026-11-04 09:00+03:00 (not a taken day); README and `config.json` agree (test reads both); CI workflow passes on the branch.

## Not done / limits
Social runtime paths (WhatsApp bridge, Meta publish, WordPress hosting, HyperFrames render) could not be executed here and were reviewed by reading only. Wikidata, GSC/Bing and live-site checks were out of scope (no secrets, no outbound posting).
