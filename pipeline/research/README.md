# Beyond Paradise Research Pipeline

Gather verified, cited facts. Tim reviews. Publish with confidence.

## Setup (one time)

1. Copy `.env.example` to `.env` at the project root and add your provider keys:
   ```
   GEMINI_API_KEY=AIza...
   PERPLEXITY_API_KEY=pplx-...
   OPENROUTER_API_KEY=sk-or-v1-...
   DEEPSEEK_API_KEY=sk-...
   OPENAI_API_KEY=sk-...
   ANTHROPIC_API_KEY=sk-ant-api03-...
   TAVILY_API_KEY=tvly-...
   BRAVE_API_KEY=BSA_...
   ```
   Gemini remains the primary grounded provider because grounding is free under the daily tier.

2. Dependencies are already installed (`npm install` in this directory).

## Provider routing

The engine follows the shared Matlai cost plan: free/cheap first, paid fallback only when needed.

### Grounded web research

1. **Gemini grounding** (`GEMINI_API_KEY`) — primary. Best default for this project because it returns real grounded domains and is free under the normal daily tier.
2. **Tavily search** (`TAVILY_API_KEY`) — free-search fallback when `RESEARCH_USE_SEARCH_FALLBACK=1` or Gemini is skipped. It feeds real snippets into the structuring step.
3. **Brave search** (`BRAVE_API_KEY`) — search fallback after Tavily.
4. **Perplexity Sonar** (`PERPLEXITY_API_KEY`) — final grounded fallback if Gemini/search fail. Better citation UX, but paid, so use sparingly.

Set `RESEARCH_SKIP_GEMINI=1` to force the fallback chain for a test run. Set `RESEARCH_USE_SEARCH_FALLBACK=1` to try Tavily/Brave before Perplexity when Gemini fails.

### JSON structuring

1. **Ollama qwen3:8b** (`RESEARCH_USE_OLLAMA=1`) — free local option when Ollama is running.
2. **Gemini JSON mode** — default cloud structuring path.
3. **OpenRouter** (`OPENROUTER_API_KEY`) — cheap fallback via `google/gemini-2.5-flash-lite`, then `deepseek/deepseek-chat`.
4. **DeepSeek direct** (`DEEPSEEK_API_KEY`) — cheap direct extraction fallback when OpenRouter is unavailable.
5. **OpenAI** (`OPENAI_API_KEY`) — structured-output fallback.
6. **Anthropic Haiku** (`ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`) — final fallback for stubborn JSON failures.

### Search keys staged for v2

`YOU_API_KEY`, `SERPER_API_KEY`, and `EXA_API_KEY` are not present in the local projects I checked. If added later, slot them between Tavily and Brave in the same free-search cascade.

Older/local aliases now supported:
- `BRAVE_SEARCH_API_KEY` works as a Brave alias.
- `CLAUDE_API_KEY` works as an Anthropic alias.

Keys found but not used in this research engine:
- `BING_API_KEY` is for IndexNow/Bing Webmaster submission, not source research. Bing Web Search is retired.
- `VALUESERP_API_KEY`, `SERPAPI_API_KEY`, and `SERPAPI`-style adapters belong to AI visibility/rank tracking projects, not this fact-gathering pipeline.

## Daily workflow

### Step 1: Research a topic
```bash
cd pipeline/research

# Wildlife encounter facts
node gather-facts.js \
  --type=wildlife \
  --key=whale-shark-mafia \
  --name="Whale Sharks Mafia Island" \
  --topic=whale-sharks \
  --region=mafia-island

# Lodge facts
node gather-facts.js \
  --type=lodge \
  --key=singita-grumeti \
  --name="Singita Grumeti" \
  --topic=lodge-review \
  --region=serengeti

# Destination entry/health/season facts
node gather-facts.js \
  --type=destination \
  --key=tanzania-entry \
  --name="Tanzania Entry Requirements" \
  --topic=entry-requirements \
  --region=tanzania

# Operator ethics facts
node gather-facts.js \
  --type=operator \
  --key=aquatica-zanzibar \
  --name="Aquatica Zanzibar" \
  --topic=wildlife-ethics \
  --region=zanzibar
```

Add `--dry` to see what would be written without writing it.

### Step 2: Review candidates
```bash
# See everything waiting for review
node promote-fact.js --all --dry
```

Look at each fact:
- `✓ confirmed` = ≥2 independent owners (reliable)
- `~ single-source` = 1 owner (use with caution, add a note)
- `✗ unverified` = cannot be promoted until sources are added

### Step 3: Promote what you trust
```bash
# Promote all facts for an entity
node promote-fact.js --key=whale-shark-mafia

# Promote one specific fact by ID
node promote-fact.js --id=whale-shark-mafia-season-1

# Promote everything in the buffer
node promote-fact.js --all
```

Facts go into `data/facts/facts.json`. You can use them on the site.

### Check status
```bash
node kb-status.js           # summary
node kb-status.js --verbose  # breakdown by topic and region
```

## Spend guard

The engine uses Gemini 2.5 Flash with grounding (web search).
- Free: ~1,500 grounded calls/day
- Default cap: **200 calls/day, 30 per run** (very conservative)
- Emergency stop: `touch .research-kill` at the project root — blocks all calls instantly
- Check spend: `node kb-status.js`

## What gets blocked

- **tripadvisor.com** — user reviews, unverifiable
- **booking.com** — commercial platform reviews
- **padi.com/blog** — marketing content
- **liveaboard.com** — operator aggregator, conflict of interest

These are defined in `data/facts/sources.json → avoid_list`.

## Independence rule

A fact is `confirmed` only when ≥2 **independent owners** support it.
Two pages on singita.com = 1 owner. IUCN + Marine Megafauna Foundation = 2 owners.

This means "two tour operators both say whale sharks come in October" is `single-source`
(they're both operators = same incentive to overstate), but "IUCN + MMF both say October" is `confirmed`.
