# Beyond Paradise Research Pipeline

Gather verified, cited facts. Tim reviews. Publish with confidence.

## Setup (one time)

1. Copy `.env.example` to `.env` at the project root and add your Gemini API key:
   ```
   GEMINI_API_KEY=AIza...
   ```
   Get a free key at https://aistudio.google.com/apikey

2. Dependencies are already installed (`npm install` in this directory).

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
