# GA4 "AI Assistants" channel group + `ai_source` tagging

Makes AI-assistant visits (ChatGPT, Perplexity, Claude, Gemini, Copilot, ...) show up as their **own channel** in GA4 instead of
being buried in "Referral" / "Direct". No GA4 Admin API, no credentials, no code deploy needed for the channel itself.

Files: `channel-group.json` (the rule, single source of truth) - `ai-source.mjs` (Node classifier + tests) -
`gtm-ai-source.html` (GTM Custom HTML tag that pushes `ai_source` to the dataLayer).

## Part A - the channel group (5 minutes, GA4 UI, forward-looking only)

> Needs the property owner/editor to click through the GA4 UI (Tim). Channel groups are **not retroactive for history**
> unless you use a *custom channel group* (this is one: it re-processes historical data in reports).

1. GA4 -> **Admin** (gear, bottom left) -> under *Data display* choose **Channel groups**.
2. **Create new channel group** -> name `AI Assistants` (description from `channel-group.json`).
3. **Add new channel** -> name `AI Assistants`.
4. Condition: dimension **Source** (this is `sessionSource`) -> **matches regex** ->
   paste the regex from `channel-group.json` (`channelGroup.channel.condition.regex`):
   `chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|bing\.com/chat|you\.com|phind\.com|poe\.com|meta\.ai|grok\.com|deepseek\.com|kagi\.com|copilot\.com`
5. **Drag the new channel ABOVE "Referral"** (GA4 uses first-match ordering; below Referral it never fires). Also above "Organic Search" is not needed.
6. Keep the rest of the default channels: click **+ Add default channels** / copy from the *Default channel group* so nothing disappears. **Save group**.
7. Use it: Reports -> Acquisition -> Traffic acquisition -> change the primary dimension to
   `Session <AI Assistants group name>`. Or Explore -> Free form -> dimension *Session AI Assistants*.

Caveats (also in `channel-group.json`):
* `sessionSource` holds the **host only**. `bing.com/chat` can therefore never match; Bing Chat arrives as `copilot.com`
  or via `utm_source` - hence the extra `copilot\.com` alternative (an addition to the audit's list).
* ChatGPT appends `utm_source=chatgpt.com` to links it opens; Perplexity/Claude/Gemini depend on the referrer header and
  are under-counted when opened in an in-app browser. Treat the numbers as a **floor**.
* GA4 only counts visitors after GTM loads and consent allows it, so compare with a cookieless source (Cloudflare Web Analytics).

## Part B - `ai_source` tagging via GTM (optional, adds a clean label per assistant)

1. GTM -> Tags -> New -> **Custom HTML** -> paste `gtm-ai-source.html`. Trigger: **Initialization - All Pages**.
2. Variables -> New -> **Data Layer Variable** `ai_source` (name it `dlv - ai_source`).
3. On the GA4 **Configuration / Google tag**: Fields to set -> `ai_source` = `{{dlv - ai_source}}`
   (or add it as an event parameter on key conversions).
4. GA4 -> Admin -> **Custom definitions** -> *Create custom dimension*: scope **Event** (or User), name `AI source`,
   event parameter `ai_source`. Takes up to 24h to appear.
5. Preview in GTM Tag Assistant with `?utm_source=chatgpt.com` appended to any URL: the tag must push `{ai_source:'chatgpt'}`.

The snippet stores the label in `sessionStorage` (no cookie, no consent needed for the tagging itself), so later pages in the
same visit stay labelled - the ChatGPT referrer is only present on the landing page.

## Part C - dashboards

`matlai-site/scripts/dashboard.mjs` already queries `sessionSource` with a looser regex
(`chatgpt|openai|perplexity|gemini|copilot|claude|bard|you\.com|phind|deepseek|meta\.ai`). Once the channel group exists,
the cluster-rollup `--sessions` input can be fed from a GA4 report: dimension *Landing page*, metric *Sessions*,
filter *Session AI Assistants = AI Assistants*.

## Test it (no GA4 needed)

`node --test tests/ga4-ai.test.mjs` - checks the regex hits every assistant host, misses `google`, `bing`, `facebook.com`,
and that the GTM snippet and the Node classifier agree.
