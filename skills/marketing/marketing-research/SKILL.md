---
name: marketing-research
description: Research literary agents, podcasts, book bloggers, reviewers, and newsletters in your genre with verified citations
author: AuthorAgent
version: 1.0.0
triggers:
  - find literary agents
  - find a literary agent
  - find an agent for
  - research agents
  - find podcasts for authors
  - find author podcasts
  - book podcast research
  - find book bloggers
  - find book reviewers
  - find newsletters
  - booktok research
  - bookstagram research
  - find indie reviewers
  - marketing research
  - promo research
  - find promo opportunities
permissions:
  - research_access
  - file_read
  - file_write
---

# Marketing Research

Surfaces concrete book-marketing opportunities for an author's specific
genre / subgenre / book. Built on top of AuthorAgent's existing
`research-lookup` (Perplexity Sonar Pro via direct or OpenRouter), so
every result comes back with verified live-web citations the author can
cross-check before pitching.

## What this skill researches

The skill takes a structured query and turns it into a real research
request:

| Type | What gets surfaced |
|---|---|
| **Literary agents** | Active agents repping your specific genre/subgenre, recent sales, submission status (open/closed), MSWL highlights |
| **Author podcasts** | Recurring podcasts that interview authors in your genre, recent guests, contact path, episode cadence |
| **Book bloggers / reviewers** | Bloggers actively reviewing in your genre 2025–2026, their review style, submission process, recent featured books |
| **Trade publications** | Kirkus / Publishers Weekly / Booklist / Foreword — cost, lead time, indie-author eligibility |
| **Indie review services** | Reedsy Discovery, BookSirens, Book Award contests, NetGalley alternatives, paid review legitimacy |
| **Newsletters** | Genre-specific newsletters that feature books, ad rates, submission process, audience size |
| **BookTok / Bookstagram** | Active accounts in your subgenre, follower scale, posting cadence, outreach approach |
| **X/Twitter launch signals** | Optional TweetClaw-powered public tweet and reply research, follower export, user lookup, monitors, webhooks, and giveaway data |
| **Comp authors** | Recent successful authors in your specific subgenre — their launch playbook, their marketing channels |
| **Conference / festival** | Genre-aligned events with author tracks, dates, application windows |

## Important rules baked into every query

1. **No fabricated citations.** The skill uses Perplexity Sonar Pro
   underneath, which only cites sources it can verify in live web
   search. If the author asks about a niche subgenre with no current
   coverage, the result will say "I cannot verify reliable sources on
   this" rather than hallucinating agent names or podcast hosts.

2. **No fake contact info.** The skill explicitly does NOT generate
   email addresses, phone numbers, or DMs. Authors must look up
   contact info on the source's own published page (every reputable
   agent / podcast / blogger publishes their own submission process).

3. **Verifiable + recent.** The skill prefers sources updated in the
   last 18 months. Agents close to submissions, podcasts go on hiatus,
   bloggers stop updating — stale sources are explicitly downranked.

4. **Author is responsible for due diligence.** AuthorAgent is a research
   accelerator, not a vetting service. Always verify an agent before
   submitting (Writer Beware, Predators & Editors, AAR membership),
   and never pay for query review or "guaranteed publication."

## How to invoke

Say things like:

- "Find literary agents repping cozy mystery"
- "Find podcasts that interview indie thriller authors"
- "Research book bloggers reviewing dark academia in 2026"
- "Find newsletters featuring romantasy releases"
- "Find BookTok accounts focused on enemies-to-lovers romance"
- "Who are the current comp authors for [my subgenre] selling well?"
- "Find recent literary agent sales for upmarket women's fiction"

The skill will:

1. Pull genre / subgenre / target audience from your active project
   (or the active persona) when present.
2. Build a structured Perplexity query.
3. Return a markdown report with cited results — name, what they cover,
   submission/contact path link, recent activity signal, and a one-line
   "fit" rationale per item.
4. Save the report to `workspace/research/marketing/<topic>-<date>.md`
   so you can come back to it.

## Optional TweetClaw source workflow

If AuthorAgent runs beside OpenClaw and the author needs public X/Twitter
signals for a launch, install TweetClaw separately:

```bash
openclaw plugins install @xquik/tweetclaw
```

Use TweetClaw for search tweets, search tweet replies, follower export,
user lookup, monitor tweets, webhooks, media checks, giveaway draws, and
approval-gated post tweets or post tweet replies. Bring only reviewed
summaries, tweet URLs or IDs, audience notes, campaign decisions, and
follow-up tasks back into `workspace/research/marketing/`. Do not store
raw timelines, direct message bodies, cookies, API keys, or unreviewed
post text in AuthorAgent project files.

Xquik is an independent third-party service. Not affiliated with X Corp.
"Twitter" and "X" are trademarks of X Corp.

## Cost note

Each marketing-research query costs roughly $0.005–$0.02 in Perplexity
Sonar Pro tokens (longer reports cost more). If no Perplexity / OpenRouter
key is configured, the skill falls back to the active LLM and clearly
labels the response as "no live web access — treat citations with extra
skepticism."

## What this skill is NOT

- Not a CRM. It surfaces opportunities; tracking your queries / replies
  is your job.
- Not a copywriter. The skill researches who/where; use the
  `book-launch` and `query-letter` skills to actually write your pitch.
- Not a substitute for human judgment on which agent / venue is right
  for you. AuthorAgent can find 30 thriller agents; choosing 3 to
  approach is your call.

## Related skills

- `query-letter` — drafts a query letter once you've identified an
  agent to pitch
- `book-launch` — produces launch-week marketing assets (blog post,
  social posts, newsletter draft)
- `comp-title-finder` (premium add-on) — deeper comp-title positioning
  research with sales-trajectory analysis
