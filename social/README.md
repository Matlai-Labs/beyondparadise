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
Links are disabled (`includeLinks:false`) until the site is live. Instagram: each approved post is rendered as an 8-second **Reel** (`video.js` → HyperFrames, headless
Chrome + FFmpeg, CPU-only, ~15–60 s) in the brand tokens, hosted via the padelrevive.com media
library, published by the worker at the scheduled time (IG has no API scheduling). `instagram.format`
`"image"` falls back to the static Pillow card (`card.py`). Enable with `instagram.enabled=true` in `config.json` once `instagram_content_publish`
is granted (re-run `meta-pages/connect.js`). Logs: `~/Library/Logs/beyondparadise/social.log`.
Meta access: `shared_knowledge/scripts/meta-pages` (tokens in `~/.config/meta-pages/`).
