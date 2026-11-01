# bpa-social — Beyond Paradise Adventures social pipeline

Weekly: BPI briefs (last 7 days) → ≤3 deterministic drafts ($0; BPI already wrote the prose) →
brand + voice-lint gate → `queue.json` (pending) → WhatsApp message → Tim replies `bpa approve B1`
→ scheduled Facebook Page post (09:00 EAT, one per day) → worker reconciles → posted.

| Piece | Runs as | Notes |
|---|---|---|
| `draft.js` | launchd `com.beyondparadise.bpa-draft` Mon 07:00 | `--dry-run` prints without saving/sending |
| `approval-server.js` | launchd `com.beyondparadise.bpa-approval` KeepAlive, 127.0.0.1:3028 | bridge routes any `bpa …` WhatsApp message here |
| `worker.js` | launchd `com.beyondparadise.bpa-worker` every 15 min | reconcile with Meta, expire 7-day-old drafts, alerts (6 h dedupe), Monday heartbeat |

Commands (WhatsApp self-chat): `bpa` · `bpa approve B1 B2` · `bpa skip B1` · `bpa edit B1: text` ·
`bpa post B1 now` · `bpa status` · `bpa help`. Nothing is ever posted without an explicit approve.
Links are enabled (`includeLinks: true`) — the gate existed only until the site went live on
2026-09-14. A test asserts this line and `config.json` agree, so the two cannot drift again.
Instagram: each approved post is rendered as an 8-second **Reel** (`video.js` → HyperFrames, headless
Chrome + FFmpeg, CPU-only, ~15–60 s) in the brand tokens, hosted via the padelrevive.com media
library, published by the worker at the scheduled time (IG has no API scheduling). `instagram.format`
`"image"` falls back to the static Pillow card (`card.py`). Enable with `instagram.enabled=true` in `config.json` once `instagram_content_publish`
is granted (re-run `meta-pages/connect.js`). Logs: `~/Library/Logs/beyondparadise/social.log`.
Meta access: `shared_knowledge/scripts/meta-pages` (tokens in `~/.config/meta-pages/`).

## Draft score (advisory)
`score.js` gives every new draft a `score` shown under it in `bpa` / `bpa approve` lists: `score 72/100 · hook 7/10 · rubric 6/9 ✗ cta, hashtags`.
Total = 60% rubric pass-rate + 40% hook score. The 12-part rubric has 9 post-level checks (hook window, concrete hook, one ask, 3-5 hashtags,
brand/links, no slop, concrete fact, readability, length) and 3 profile-level parts (bio, highlights, grid) that are judged monthly and excluded.
It is advisory only: it never blocks, edits or re-statuses a draft, and it does not predict reach. Pattern from Jakeschincariol/Instagram-agent-skill (MIT).

## External resources (`resources.js`)
Everything outside this repo is resolved in one place, overridable by env var, and fails with a
message naming the var rather than a bare `ENOENT` mid-publish. Defaults are the paths the code used
before, so an unconfigured Mac behaves exactly as it did.

| Env var | Default | What |
|---|---|---|
| `VOICE_LINT_PATH` | `…/shared_knowledge/scripts/voice-lint/voice-lint.mjs` | voice gate (fails closed if absent) |
| `META_PUBLISH_PATH` | `…/shared_knowledge/scripts/meta-pages/publish.js` | Facebook/Instagram posting |
| `META_TOKENS_PATH` | `~/.config/meta-pages/tokens.json` | read only, to check granted scopes |
| `BPA_MEDIA_ENV_FILE` | `…/Padel_Revive/.env` | `WP_*` credentials used to host cards/reels — see audit finding 6, the host itself is still open |
| `BPA_GSAP_PATH` | `social/node_modules/gsap/dist/gsap.min.js` | reel animation library, copied into the render dir; the render no longer fetches it from a CDN |
| `BPA_GRAPH_VERSION` | `v21.0` | Graph API version |
| `BPA_META_AUTH_HEADER` | unset | `1` sends the Meta token as `Authorization: Bearer` so it stays out of URLs and logs. Default off: that form could not be confirmed against Meta from the cloud session that wrote it. Turn it on once one real Graph call succeeds, then leave it on. |

The reel footer tagline is `config.json` → `reelTagline` (a published claim; wording is Tim's).
`npm install` must have been run in `social/` — the render copies gsap out of `node_modules`.

## Approval endpoint authentication
`POST /bpa/action` requires `BPA_APPROVAL_TOKEN` (set it for the approval server and send the same value as an `x-bpa-token` header from the WhatsApp bridge, with `content-type: application/json`). Unset = every action returns 503 (fail closed). `WHATSAPP_ALERT_TO` must also be set in the environment (no default number).
