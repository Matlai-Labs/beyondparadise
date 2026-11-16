# Beyond Paradise Adventures: earning masterplan, task list

Status: draft task list of 16 Nov 2026, written by the assistant after three audit rounds and one independent review, not yet approved by the owner. It belongs to `docs/earning-masterplan-2026-11-16.md` (the plan for the owner).

Rules for every task: nothing is published, posted, sent or deployed without the owner's yes for that item, except posts covered by the standing approval of decision 5. No spend and no new account without his word. The assistant never messages hotel staff; the owner gives staff their tasks. Deploy only from the main checkout with `site/deploy.sh`; `git push` alone changes nothing on the live site.

Labels: **FP** = read on the programme's or platform's own page on 16 Nov 2026. **NET** = a network's listing, not the programme's own page. **3P** = third party, not confirmed. **Estimate** = keyword-tool monthly average. **Assumption** = my own estimate.

---

## Stage 0, part R: the record itself (this week)

| # | Task | Who | Files or places | Checkable end state | Cost | Approval | Stop rule |
|---|---|---|---|---|---|---|---|
| R1 | Name the recording role and a backup (a role, never a name in a public file) | Owner | Private note only | Role and backup written in the private note | Staff time, about 5 minutes a day | Decision 4 | No role: the record does not start |
| R2 | Create the private observation folder and confirm the form saves a row; save one test row, read it back, delete it, log the deletion | Assistant | Observation form `pipeline/tidelog/observe.py` in the owner's private marketing repository; private folder `data/private/tide-log/` | Test row saved, read back, deletion logged | 0 | Commit | n/a |
| R3 | Change the form for the public record: fixed-point photo required; fields "washed-up seaweed" (none, little, some, a lot), "swim possible at 10:00 and 16:00", "sandbank visible", jellyfish, wind feel; free note limited to conditions | Assistant | Same form and its tests | A row without a photo is refused; a note that names seaweed farming at Michamvi is refused | 0 | Commit | n/a |
| R4 | Fix the photo point: one mark on the beach, the same frame every day, no people in the frame | Owner (one message to his staff) | n/a | 3 test photos in the same frame | 0 | n/a | n/a |
| R5 | Record daily, once in the morning at a fixed time, plus once at low tide when staff are on the beach | Recording role | The form | One row a day | Staff time | n/a | Counted at day 30 |
| R6 | Weekly check: photo time against the row; frame; gap list; observed-versus-model differences a traveller would act on; seaweed wording | Assistant | Private check log | One check line a week; gaps listed, never filled | 0 | n/a | n/a |
| R7 | Mark every past row "model" (the backfilled rows and all others) so nothing model-made is ever shown as observed | Assistant | Tide-log data and its public feed | Every row carries its source: "observed" or "model" | 0 | Commit | n/a |
| R8 | Data licence: until a paid licence or another source is approved, the public record shows only human observations and photos; write the licence line on the data page and in the spend guard | Assistant drafts, owner decides (decision 2) | Data page; spend guard | Licence line live; no model figure in public | 0 now; paid plan price not shown on the provider's page | Owner (spend) | No paid link and no model figure in public before this |
| R9 | Method page: who records (the role, and its tie to the owner's hotel, in the same sentence), where, when, how it is checked, what "model" means, "not a safety forecast", the seaweed wording rule. After 30 days, the first month page with gaps shown | Assistant drafts, owner approves | New pages, for example `/record/method/` and `/record/2026-12/` | Both live; the month page shows days recorded out of days in the month | 0 | Text and deploy | The month page waits for the day-30 proof |
| R10 | The live pages contradict each other about who owns the owner's hotel and which of the owner's names stands on the site. The owner settles one wording; the assistant applies it on every page before R9 goes live | Owner decides, assistant applies | `/about/editorial-policy/`, the scoring methodology page, `/about/`, `CLAUDE.md` | A site search finds one wording only | 0 | Text and deploy | R9 does not go live before this |
| R11 | Day-30 proof: count observed days with a matching photo; count days where observation and model differ in a way a traveller would act on; list every "skip" or "think twice" line and whether it was changed | Assistant reports, owner decides | Monthly review | Three numbers written down | 0 | Owner | Fail: fall back to the earlier plan (see the owner's plan, section 2) |

## Stage 0, part A: truth, law and measurement (one owner sitting, then assistant work)

| # | Task | Who | Files or places | Checkable end state | Cost | Approval | Stop rule |
|---|---|---|---|---|---|---|---|
| 0.1 | Answer the five decisions, one line each | Owner | Owner's plan, section 4 | Answers saved in the project memory with the date | 0 | n/a | If decision 2 is open after 30 days, no form and no fee work starts |
| 0.2 | Confirm the site in Google Search Console and Bing Webmaster Tools; submit the sitemap | Owner (about 10 minutes) | Both consoles | Sitemap shown as submitted in both | 0 | n/a | n/a |
| 0.3 | Create a Cloudflare Web Analytics site and hand over its site key | Owner | Cloudflare dashboard | Key handed over privately | 0 | n/a | n/a |
| 0.4 | Enable the YouTube Analytics API | Owner (one click) | Google Cloud console | A statistics call returns data | 0 | n/a | n/a |
| 0.5 | Send the purchase or licence records of the bought YouTube clips | Owner | Private register | Register lists each video with source and record | 0 | n/a | No record: no YouTube income application |
| 0.6 | Replace the money paragraph with the "no money today" text; set the real "Last updated" date | Assistant | `site/src/pages/about/editorial-policy/index.astro` | Live page claims no commission income | 0 | Text and deploy | n/a |
| 0.7 | Replace both footer lines with "No paid reviews. No hosted stays." | Assistant | `site/src/components/Footer.astro` | Live footer shows the new line | 0 | Deploy | n/a |
| 0.8 | Delete the unpublished draft review file; set the operator entries marked "verified" with a score context to "not visited" | Assistant | The single draft file in `site/src/content/reviews/`; `data/operators/operators.json` | No content file claims a stay; build passes | 0 | Commit | n/a |
| 0.9 | Rewrite the brand rules to the new position: remove personal names and the hotel's name, "trips above 6,000 euros only", "every claim first-hand", the count of properties reviewed, and the encounter index as "keystone"; keep the rules as "the owner" and "the owner's hotel" | Assistant drafts, owner approves (these are brand rules) | `CLAUDE.md` | A search of the file finds no personal or hotel name and none of the removed lines | 0 | Owner | n/a |
| 0.10 | Scoring methodology page says plainly that no scored reviews are planned; remove the home-page counter of zero scores; replace "Written from Zanzibar, where we live" with "Recorded on Zanzibar every day" | Assistant | `/about/` pages, home page, footer | Live pages changed | 0 | Text and deploy | After R10 |
| 0.11 | Load the visit counter with the key from 0.3 | Assistant | Private `site/.env`; base layout | The live home page loads the counter; one visit shows | 0 | Deploy | n/a |
| 0.12 | Prove that approval prompts reach the owner (details in the private note); repeat monthly | Assistant | Social approval job | One prompt received, proven in the bridge log | 0 | n/a | If it fails, no drafting until fixed |
| 0.13 | Switch Instagram and Facebook posting of the tourism statistics drafts off | Assistant | `social/config.json` | Next weekly run posts none | 0 | Commit | n/a |
| 0.14 | First-person title rule: every video or Short whose title or text suggests the brand was there, over footage that is not its own, gets a new title and text. Videos stay public | Assistant drafts, owner approves once as a batch | `social/youtube-channel-edit.js` (plan, apply, undo) | All changed titles read back; none left that breaks the rule | 0 | One batch approval | n/a |
| 0.15 | Draft the brief for the legal opinion (three questions in decision 2) and a short list of firms | Assistant | Private file | Brief ready | 0 | n/a | n/a |
| 0.16 | Draft the imprint and the privacy page, including consent wording for passing an enquiry to an operator outside the EU | Assistant, after decision 2 | New pages under `site/src/pages/about/`; footer links | Both pages live and linked from every page | 0 | Text and deploy | Not before decision 2 |
| 0.17 | Side-by-side comparison of both sites over the same 28 days (Search Console and Bing clicks, pages with own photos, AI citations, owner hours) | Assistant | Both consoles | One page for decision 1 | 0 | n/a | Needs 28 days of data for this site after 0.2 |

## Stage 1 and 2: month pages, partners, free matching (months 2 to 6)

| # | Task | Who | Checkable end state | Cost | Approval | Stop rule |
|---|---|---|---|---|---|---|
| 1.1 | Partner observation points on other coasts: ask one Paje kite school, one dive centre in the north, and a research group to send the same form. Credited by name and link, not paid. Check whether any of them does business with the owner's hotel and say so | Owner asks, assistant drafts the request | At least one partner sends rows for 30 days | 0 | Owner per request | None in 90 days: the record stays one beach and says so |
| 1.2 | Official-rules tracker, six rules: Zanzibar insurance fee, Tanzania visa route, Jozani entry fee, ferry fares, park fees, one airport or departure fee. Each with the official page, a dated screenshot, and what other sites say | Assistant | At least 4 of 6 read on an official page | 0 | Each page | Fewer than 4 readable: publish only those |
| 1.3 | Re-check every Zanzibar fact in the fact base; publish a change log with every change and every failed check | Assistant | All re-checked; failures shown with a date | 0 | Owner (showing failures) | If failures may not be shown, drop the change log |
| 1.4 | Weekly note with "go / think twice / skip" for three east-coast activities, judged only from the record (low-tide walk to the sandbank, a swim at 10:00, the sunset boat) | Assistant drafts; standing approval | Four notes in 30 days, at least one "skip" or "think twice" unchanged | 0 | Decision 5 | Every week "go": check the photos for softening |
| 1.5 | Publish the assessment criteria for operators and two or three short assessments from the owner's knowledge; ask each operator whether it does business with the owner's hotel | Assistant drafts, owner approves | Each assessment live before the first introduction | 0 | Each assessment | Operator tied to the hotel: named as such, or not used |
| 1.6 | Publish the money rules (owner's plan, section 6) with "Today nobody pays us for introductions" | Assistant | Page live, linked from footer and policy | 0 | Text and deploy | n/a |
| 1.7 | Enquiry form on the month pages and in the letter (trip type: safari plus Zanzibar) with the consent box; private enquiry list | Assistant | A test enquiry reaches the owner | 0 to 20 euros a month for a form service (assumption) | Text, service, deploy | Not before the privacy page and consent wording |
| 1.8 | After the trip month, ask the traveller one question: "Did you travel with [operator]?" | Assistant drafts, owner sends | Answer logged | 0 | Each send | n/a |
| 1.9 | Weekly letter (free plan, ad network off) | Assistant | Form live; first letter sent | 0 | Text, account, standing approval | Not before the privacy page |
| 1.10 | Citable data: one stable name for the record, a download file, Dataset markup, a licence line, an entry for AI assistants, submission to Bing; a monthly AI-citation check with five month-and-coast questions in English, German and Italian | Assistant | First month's data downloadable; first check run | AI check: small, capped (assumption) | Owner (spend) | n/a |
| 1.11 | 60-day test: link the first month page from five pages of the other site; compare Bing impressions and AI citations of both copies | Assistant | One-page result for decision 1 | 0 | Owner | If the other site's copy is cited and this one is not, decision 1 moves the record there, and that site stops promoting the hotel |
| 1.12 | Shot list for the owner's next stay on the island, after R9 | Assistant writes, owner films | Own footage and receipts from at least three excursions | Excursion prices (assumption) | Owner | n/a |
| 1.13 | Instagram: new biography; record clips and photo posts only; Africa channel: record clips and one month video | Owner (profile by hand), assistant (posts) | Profile matches the owner's plan, section 7 | 0 | Standing approval for record posts | After 90 days of mostly original posts, under 300 non-followers reached a month: Instagram becomes a mirror |
| 1.14 | Day-90 gate of the free matching test | Assistant reports, owner decides | Count of real enquiries written down | 0 | Owner | Fewer than 3: the referral line waits |
| 1.15 | Month-6 gate of the visit counter | Assistant reports, owner decides | Visits a month written down | 0 | Owner | Under 300 and not rising: change course (owner's plan, section 8) |

## Stage 3: grow what the numbers support (month 6 onward)

| # | Task | Who | Gate |
|---|---|---|---|
| 3.1 | Fee agreements: one equal fee; fee base excludes any Zanzibar accommodation, shown on the operator's invoice; same price for the reader; no say over any text; the operator confirms each enquiry number within 7 days; the brand invoices per booking; ends on any breach | Owner signs, assistant drafts | Day-90 gate passed, written legal opinion allows it, money rules live, owner says yes |
| 3.2 | Cross-border payment: currency, bank charges, possible withholding tax in Tanzania (not researched) | Owner with adviser | Before the first invoice |
| 3.3 | Supporting paid links, only where they fit the record; top label; `rel="sponsored noopener"`; a build check that fails a paid link without a label; a weekly link health check copied from the sister site's pattern | Assistant | 1,000 measured visits a month and the data licence settled |
| 3.4 | Italian month page, translated by the existing pipeline and checked once by a native reader ("zanzibar quando andare": 9,900 searches a month, estimate) | Assistant, owner approves | After 2 month pages exist |
| 3.5 | Reader photos: accepted only with place, time and the original file; marked "reader" in the data; no people recognisable | Assistant | After the letter has readers |
| 3.6 | Continuity: the record belongs to a role with a backup; a one-page method; partner points; the owner states what happens to the record if the hotel changes hands | Owner and assistant | Before month 6 |
| 3.7 | Asia: frozen. The Vietnam hub is not published; the arrivals reader stays on its branch as a ready data page; Hanoi only if the owner's planned project there becomes real and someone there agrees to record | Owner decides | Not before people are on the ground |
| 3.8 | Not planned: paid mainland stays and scored lodge reviews. Reconsider in year 2 only if enquiries ask for lodge advice | Owner | n/a |
| 3.9 | Later options: a fixed-fee planning call after the legal opinion and the free test; the trade brief stays with the intelligence project (hotel conflict) | Owner | n/a |

---

## Appendix A: candidates the advantage was chosen from (short)

Hard to copy: 1 = a writer copies it in a day; 5 = nobody can copy it within a year even with money.

| Candidate | Hard to copy | Note |
|---|---|---|
| Daily observed sea and beach record | 3 | A rival can hire an observer; it cannot go back in time or say "skip" if it sells the beach |
| Daily model log alone | 1 | Anyone can call the same free model |
| "The month as it really was" pages built on the record | 4 | Serves the large "when to go" demand; head start grows each month |
| Dated fact base shown as a public standard | 2 | Dates are cheap; a real re-check history with failures shown is not |
| Tourism data for travellers | 3 | No traveller demand found; data posts drew one like each |
| Partner observation points | 3 | Partners are loyal to whoever asks first |
| Official-rules tracker | 2 | A quality edge, not a moat; fastest proof (7 to 10 days) |
| Honest "skip this" verdicts | 4 against sellers, 2 against a blogger | Sellers cannot write "skip" |
| Dated paid-price ledger | 4 | Cannot be backfilled; but the steady price source on the island is the hotel's suppliers (conflict). Expected to fail while the owner is away |
| Public change log and monthly numbers | 2 | Easy to start, hard to keep honest |
| The hotel conflict stated openly | 3 | Today a weakness: the live pages contradict each other |
| German and Italian readers | 1 | Language is not a moat; a dated record in those languages is rarer |
| The owner's own 2020 safari photos | 5 (the files) / 1 (the value) | Prove little about Zanzibar today |
| Holiday and Ramadan calendar | 1 | Already served elsewhere by the owner |
| Reader observations | 3 | Needs readers first |
| Guest mail topics | 5 | Guest data: planning input only, local model only, never public |

## Appendix B: what the evidence says

### B.1 Income models ranked by fit

| Rank | Model | Confirmed facts | Main risk |
|---|---|---|---|
| 1 | Matching readers to vetted operators (free first, fee later) | Safari.com: 15 to 22.5 percent of gross profit, paid after travel; about 600 dollars on a 20,000 dollar booking (FP). Go2Africa: 2 percent, 30-day cookie (FP). Safari Travel Plus: 5 or 7.5 percent, paid 2 weeks after the safari (FP). SafariBookings: operators pay 5 to 10 percent per quote request; 5 to 6 requests per booking (FP) | Payment can bend a verdict; legal duties; tracking |
| 2 | Labelled links | Viator 8 percent, 30 days (FP). GetYourGuide at least 8 percent (FP). Civitatis 8 to 10 percent (FP). Global Rescue 10 percent, 6-month cookie (FP). Airalo up to 10 percent (FP). Welcome Pickups 8 percent on transfers (NET, Travelpayouts) | Small sums; each programme needs the legal entity; Booking.com cut thousands of small partners on 30 days' notice in 2025 |
| 3 | Reader support and newsletter | An independent Vietnam site says after 12 years it makes "some revenue, but not a lot" (FP, June 2024) | Small |
| 4 | Planning call | 55 to 500 dollars an hour (3P) | Demand unproven |
| 5 | YouTube ad income | 1,000 subscribers and 4,000 watch hours in 12 months (FP); both channels together hold less than half that in their whole life, even at five minutes a view (arithmetic, 16 Nov 2026) | Reused-content rule |
| 6 | Trade brief, data licensing, display ads, host agency, group trips | No buyer, no payouts found, or a direct conflict | Rejected for this brand |

### B.2 Lessons from the owner's sister site (sports gear and injury topics)

Traffic is the cap, not conversion (proven). One page per buying question beats broad pages (proven for gear). Publishing hundreds of pages in a few weeks was followed by many pages dropping out of Google (observed; cause unproven). Invented trust signals were found and cost search features (proven). Put the link where clicks land (proven as a failure). A weekly link check works (proven; income effect unproven). Cold link-swap emails fail (proven, weakly). An affiliate network application stalled for weeks on the open question of the selling entity (observed; that is decision 2 here).

### B.3 What AI answers and Bing do

- With a Google AI summary, users clicked a normal result in 8 percent of visits, against 15 percent without (Pew Research, 22 Jul 2025).
- Organic click rate on information searches with an AI overview fell 61 percent, June 2024 to September 2025 (Seer Interactive). Moderate evidence.
- Travel sites: a median 2.15 AI-assistant visits per 100 Google visits, March to August 2026 (SEOcrawl, vendor). Moderate evidence.
- UK travel sites: 0.37 percent of traffic from AI assistants, converting better than average (Adido for ABTA, 41 sites). Weak to moderate.
- The owner's other site gets far more clicks from Bing than from Google and is cited by AI assistants (internal audit, figures not published). So Bing and AI assistants are counted from day one.

### B.4 Competitors (search tool, 16 Nov 2026; first-listed, not proven top-ranked)

- Sellers and marketplaces fill "best time", "where to stay" and "is it safe" with undated, unsigned pages. A new site gets no edge there without data.
- Nobody found publishes seaweed by beach and week, a per-beach swim window, dated paid prices, or current official fee detail with a link to the official page.
- Quote ranges for the same trip spread up to eight times (for example a spice tour, 32 to 275 dollars). No receipts anywhere.
- Mainland luxury lodge reviews are owned by agencies with trip volume: hopeless for a Zanzibar-based brand.

### B.5 Platform and legal rules

- **YouTube reused content (FP):** allowed only "if viewers can tell that there's a meaningful difference".
- **YouTube countries (FP):** Tanzania and Germany listed for full ad income; Tanzania not listed for the lower tier or Shopping affiliate. Programme updates from 1 Feb 2027.
- **Instagram (FP):** accounts that mostly post unoriginal work may not be shown to new audiences; eligibility returns after about 30 days of mostly original posts. Affiliate posts need the paid partnership label. Up to five profile links.
- **Google (FP):** paid links get `rel="sponsored"`; reviews should show own experience; mass AI pages count as spam.
- **Germany (FP, UWG section 5a):** commercial purpose must be clear; "Werbung" or "Anzeige" are the labels named in a 3P summary of the regulators' guide. **Imprint (FP, DDG section 5):** name, address, fast electronic contact, register and VAT numbers if they exist.
- **UK (FP, ASA, 22 Mar 2023):** "affiliate" is not widely understood; a note at the bottom is not enough.
- **EU package travel (Article 20, Directive 2015/2302, legislation.gov.uk copy):** where the organiser is outside the European Economic Area, "the retailer established in a Member State shall be subject to the obligations laid down for organisers ... unless the retailer provides evidence that the organiser complies". Whether this applies to an introduction is question 1 for the legal opinion.
- **Model data licence (FP, Open-Meteo terms):** "You may only use the free API services for non-commercial purposes"; data under CC BY 4.0. The paid plan with marine data shows no euro price on its page.
- **Wise (FP):** referral rewards cannot be paid in Tanzanian shillings.
- **Marketplace pricing (FP):** SafariBookings adds a marketing budget to tour rates: 10 percent in its agreement, 12.5 percent in its help pages. This is why rule 7 needs a written clause.

## Appendix C: not verified

- Whether staff observations are saved anywhere other than the private folder named in R2.
- Real ranked search results, AI answers and video rows for any query.
- Keyword volumes are Google Ads estimates for keywords picked from Zanzibar topics; topic sums depend on word lists (best time: about 22,300 by my list, 28,490 by the analysis's list) and are not traffic.
- Whether the owner's hotel sells excursions, and which operators work with it.
- The price of the paid model-data plan; whether an open tide computation is accurate enough; whether the brand's use counts as commercial before any paid link exists.
- Whether any kite school, dive centre or research group would join for credit.
- Whether guests at east-coast villas complain about tides and seaweed (assumption, not counted).
- How long a rival would really need to hire an observer.
- The legal questions in decision 2 (no legal advice is given here). Whether Tanzania has an EU adequacy decision.
- Instagram follower quality at profile level; YouTube watch hours (statistics off until 0.4).
- Programme terms marked 3P or NET.

## Appendix D: sources (first-party pages, read on 16 Nov 2026 unless dated)

| Address | Supports |
|---|---|
| https://open-meteo.com/en/terms | Free use only for non-commercial purposes; CC BY 4.0 |
| https://open-meteo.com/en/pricing | Paid plan includes marine data; no euro price shown |
| https://www.legislation.gov.uk/eudr/2015/2302/article/20 | Retailer duties when the organiser is outside the EEA |
| https://www.safari.com/affiliates | 15 to 22.5 percent of gross profit; average fee |
| https://www.safari.com/affiliate-terms | Paid after travel; disclosure required |
| https://www.go2africa.com/safari-affiliate-program | 2 percent, 30-day cookie |
| https://www.safaritravelplus.com/affiliates/ | 5 and 7.5 percent; paid after the safari |
| https://help.safaribookings.com/hc/en-150/articles/16744855263261 | Operators pay 5 to 10 percent |
| https://help.safaribookings.com/hc/en-150/articles/21188943258141 | 5 to 6 quote requests per booking; 12.5 percent marketing budget |
| https://www.safaribookings.com/partnership-agreement-for-tour-operators | Pay per quote request; rank not "solely" set by payment (the model not to copy) |
| https://partnerresources.viator.com/ | 8 percent, 30 days |
| https://partner.getyourguide.com/en-us/ | At least 8 percent |
| https://www.civitatis.com/en/affiliates/ | 8 to 10 percent |
| https://www.travelpayouts.com/ | Network carrying Welcome Pickups and others (NET) |
| https://www.globalrescue.com/partners/travel-affiliate-program/ | 10 percent, 6-month cookie |
| https://partners.airalo.com/solutions/affiliates | Up to 10 percent |
| https://wise.com/help/articles/6hmyCEpnZKN7W3Fc0J93g8/influencer-referral-program-at-wise | Rewards not payable in Tanzanian shillings |
| https://support.google.com/youtube/answer/72851 | Programme thresholds; update from 1 Feb 2027 |
| https://support.google.com/youtube/answer/13429240 | Lower tier; Tanzania not listed |
| https://support.google.com/youtube/answer/7101720 | Full ad income countries |
| https://support.google.com/youtube/answer/13376398 | Shopping affiliate countries |
| https://developers.google.com/search/docs/essentials/spam-policies | Thin affiliation; scaled content abuse |
| https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links | `rel="sponsored"` |
| gesetze-im-internet.de, UWG section 5a and DDG section 5 | German labelling duty; imprint |
| https://www.which.co.uk/about-which/our-statement-of-editorial-independence-aFnFu0X8HMSl | No payment for reviews |
| https://thepointsguy.com/tpg-publishing-standards/ | Disclosure at the top of each page |
| https://vietnamcoracle.com/disclosure-disclaimer | Independent site; no sponsored content |
| https://skift.com/2025/05/30/why-booking-com-cut-thousands-of-affiliate-partners-and-what-comes-next/ | Small affiliates cut on 30 days' notice |
| https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/ | Clicks with and without AI summary |
| https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-september-2025-update | Click rate down 61 percent |
| https://www.seocrawl.ai/blog/ai-traffic-vs-organic-search-study | Travel AI visits per 100 Google visits |
| https://www.abta.com/industry-zone/partner-insights/how-much-traffic-do-llms-send-travel-websites-2026 | AI share of travel traffic |

Keyword estimates come from the owner's keyword report of 1 Nov 2026 (Google Ads averages). Competitor observations come from a search-tool review of 20 questions on 16 Nov 2026. The project's own facts come from the internal audits of 16 Nov 2026.
