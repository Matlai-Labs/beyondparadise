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
`igEnabled()` needs `instagram_content_publish` in `user.scopes` of that tokens file (written by `connect.js --exchange`; `connect.js --refresh-scopes` re-reads it from Meta without a new login). If `instagram.enabled` is true but that is missing, the worker (`igGate` in `lib.js`) logs one `… instagram NOT published, Facebook only: <reason>` line per affected post and sends ONE WhatsApp alert per state change (blocked, then back on) — state in `queue.json` → `state.igGate`. It no longer skips quietly.

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
`POST /bpa/action` requires `BPA_APPROVAL_TOKEN` (set it for the approval server and send the same value as an `x-bpa-token` header from the WhatsApp bridge, with `content-type: application/json`). Unset = every action returns 503 (fail closed). The alert number comes from `WHATSAPP_ALERT_TO` first, then from the first line of the private file `~/.matlai/whatsapp-alert-to` (override the path with `WHATSAPP_ALERT_TO_FILE`; the line must look like `+` and 8 to 15 digits). It is never stored in the repo; with neither, alerts are skipped (fail closed) and the log says so. When the file is used because the variable is missing, the log says that once per process.

## YouTube channel editor: explicit decisions (`youtube-channel-edit.js`)
`plan --out <dir>` builds the rule-based description clean-up. `plan --out <dir> --decisions <file.json>` builds the plan ONLY from that file: the text rules are not run, so a decisions plan can never re-apply rule changes. `apply` and `undo` are unchanged in shape (`apply --plan <plan.json> --ledger <dir> [--only id,...] [--max-units N]`, `undo --ledger <file> [--only id]`; `--only` takes a video, playlist or channel id, or the `key` of a playlist-create). Nothing is written by `plan`; it reads the live objects and puts old and new values (plan.json) and a readable diff (plan.md) into the plan files.

```json
{ "ops": [
  { "channel": "asia", "kind": "video", "id": "<videoId>", "set": { "title": "...", "description": "..." } },
  { "channel": "asia", "kind": "playlist", "id": "<playlistId>", "set": { "title": "...", "description": "...", "privacyStatus": "private" } },
  { "channel": "asia", "kind": "channel", "id": "<channelId>", "set": { "title": "..." } },
  { "channel": "asia", "kind": "playlist-create", "key": "vietnam", "set": { "title": "...", "description": "...", "privacyStatus": "public" }, "items": ["<videoId>", "<videoId>"] }
] }
```
Fields: video `title`, `description`; playlist `title`, `description`, `privacyStatus`; channel `title`; playlist-create `title`, `description`, `privacyStatus` (required: `title`, `privacyStatus`). Any other key in an op or in the file is refused, so a typo cannot become a write.

**The plan is refused (exit 1, no file written, every refused op named as `decisions op #N`) when:** a field is outside that list; a video title is empty or over 100 characters, a playlist title empty or over 150, a channel title empty or over 100, a description over 5,000 characters, or any title/description contains `<` or `>`; a playlist `privacyStatus` is not `private` or `public`; an op sets a video's privacy or has kind `delete` (there is no such op); the id does not belong to the named channel or does not exist; a playlist-create item is not a public video of that channel; the text contains `beyondparadiseadventures.net` or a web address whose host is not one of `beyondparadiseadventures.com`, `www.instagram.com`, `www.youtube.com`, `www.facebook.com` (so `www.beyondparadiseadventures.com` and `instagram.com` without `www.` are refused too; write the exact host); two ops name the same object. **Dropped with a note (not refused):** a private video (`private`), a value equal to the live one (`already-applied`; an op that changes only some of its fields keeps just those), a playlist-create whose title already exists on the channel (`already-exists`).

`apply` re-checks the same content rules on every op that touches title/privacy, comes from a decisions plan or creates a playlist (a hand-edited plan.json cannot get past it), and writes in the usual order: `pending` line with ALL old snippet and status values, the write (video title/description: `videos.update` snippet with the live tags, category and languages unchanged; playlist: snippet and/or status in one call; channel title: the full live `brandingSettings`, banner untouched), read-back with the existing retries, result line. The read-back also asserts tags, category and privacy did not change. A channel rename that YouTube answers with a 4xx, or whose read-back still shows the old title after all retries, is ledgered `refused-by-youtube` and the run continues; every other mismatch or error stops the run as before.

**Creating a playlist** costs 50 units for the insert plus 50 per item and is paid for in full against `--max-units` before it starts. Ledger lines: `pending`, `created` (the new playlist id), one `item-created` per item (the playlistItem id), `done`. Running the same plan again finds the title and does nothing, so it never makes a second playlist.

**Undo** puts title, description and privacy back from the `pending` line (also when the run died before the result line). A created playlist is undone by `playlists.delete` of the id recorded on a `created` line **of the same ledger file for that same attempt and channel**, and only if the playlist still has the title this tool gave it; any other id is never deleted. A `pending` playlist-create whose insert response was never recorded does nothing and prints where to look by hand. Undo refuses ledger lines that list a field outside `ALLOWED` (for example a video's privacy).
