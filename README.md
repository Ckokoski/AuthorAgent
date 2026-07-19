# AuthorAgent

**The free, open-source AI writing agent that runs the entire book pipeline on your own machine.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-410%20passing-brightgreen.svg)](#development)
[![Security](https://img.shields.io/badge/security-hardened-green.svg)](#security)

Every author wants an agent. This one works for your book — not for 15%.

AuthorAgent takes an idea (or your existing manuscript) through **research → outline → write → revise → format → publish-ready** in one autonomous pipeline, on your computer, with your own AI keys. What a $2,000/year stack of subscriptions tries to do, one free tool does — **without your manuscript ever leaving your machine**.

**Three things that make it different:**

1. **Your book never leaves your machine.** Local-first by design. The only network calls are the AI API calls *you* configure with *your* keys. No cloud account, no manuscript upload, no "we may use your content to improve our services."
2. **One free tool, not five subscriptions.** Writing assistant + developmental editor + formatter + market research + launch planner, in one open-source agent. Pay only your own API usage — and the router spends it wisely (free models for structure, premium only where prose quality pays).
3. **Built to fight AI slop, not produce more of it.** A quality engine no other tool has: evidence-chained contradiction detection, per-character voice critics, anti-slop screening, a judge→reflect→revise evolution loop — and it *learns from its own findings*, injecting durable lessons into future writing.

---

## The Conductor's Studio

Open your book and watch the agent work:

- **✨ Start a Book wizard** — idea or upload → genre, persona, length → mode: **Full Book**, or Just Outline / Just Write / Just Polish / Just Format
- **The Book View** — every book gets a journey bar (**Plan → Write → Revise → Polish → Publish**) showing honest progress, chapter-by-chapter
- **The Orchestra** — while the pipeline runs, watch the conductor dispatch its workers live: 🔍 researching, 🗺 outlining, ✍️ drafting Chapter 3, 🧐 auditing pacing…
- **Zero-paste quality checks** — every chapter gets a "Check ▾" menu: contradictions, character critique, revision analysis — pre-filled from the manuscript the agent already holds
- **💬 Chat drawer** — talk to your agent from anywhere in the app

## The Quality Engine

This is the part built to make books *better*, not just faster:

| Tool | What it does |
|---|---|
| **Contradiction Detection** | Diffs each chapter against the book's entity database (characters, timeline, world rules) and returns evidence-chained findings — the quote in the chapter vs. the established fact |
| **Character Persona Agents** | Each major character critiques its *own* dialogue: off-voice lines, knowledge it couldn't have yet, actions against motivation — with in-voice rewrites |
| **Revision Orchestrator** | Specialist passes (continuity / voice / craft / anti-AI-slop) instead of one blunt "revise this" prompt |
| **Prose Evolution** | GEPA-style loop: judge → diagnose → revise → re-judge; keeps a candidate only if it *measurably improves*, never regresses |
| **Synthetic Reader Panels** | Tournament-tests your blurbs/titles/covers against demographically-varied reader personas, with safeguards against LLM judge collapse |
| **Learn-from-Experience** | Recurring findings become durable lessons injected into all future writing — the agent improves with use |

## Long-Book Memory

The unsolved problem of AI writing is book-length consistency. AuthorAgent ships a tiered memory system:

- **CORE** — a budgeted, always-in-prompt digest: active chapter state, the characters this scene touches, open plot threads, your style fingerprint
- **ARCHIVAL** — full-text search over the entire manuscript and past work, pulled in on demand ("what happened in chapter 12?" actually works)
- **RECALL** — raw drafts on disk, the source of truth
- **Sleep-time consolidation** — a nightly job (free-tier models only) re-summarizes character arcs, resolves plot threads, distills your voice, and prunes noise — so the agent wakes up knowing your book

## Everything Else in the Box

- **Author personas** — multiple pen names with distinct voice fingerprints and drift detection
- **Publishing suite** — 90-day launch orchestrator, AMS ads optimizer, BookBub deal builder, translation planner + executor, author-site deploys, blog drafter
- **Craft tools** — 10 story structures with outline checking, plot-promise (Chekhov's gun) tracking, series bible for multi-book continuity
- **Export** — KDP-ready DOCX and valid EPUB3
- **Audiobook prep** — script cleanup, multi-voice speaker attribution, free neural TTS (9 presets) or ElevenLabs
- **Covers** — image generation chain (OpenAI → Gemini → Flux) with cover-set output (ebook/print/audiobook/social)
- **Telegram bridge** — run your whole pipeline from your phone
- **Writing momentum** — streaks and word counts tracked automatically as the agent writes

### Optional X/Twitter Launch Signals

Authors who run AuthorAgent beside OpenClaw can install
[TweetClaw](https://github.com/Xquik-dev/tweetclaw) with
`openclaw plugins install @xquik/tweetclaw`. Use it to research public
launch signals, then bring reviewed summaries, tweet URLs or IDs, audience
notes, and follow-up decisions into AuthorAgent projects.

Xquik is an independent third-party service. Not affiliated with X Corp. "Twitter" and "X" are trademarks of X Corp.

---

## Quick Start

```bash
git clone https://github.com/Ckokoski/authoragent.git
cd authoragent
npm install
npm start

# Open http://localhost:3847
# Settings → Connections → paste a Gemini API key (free tier — a whole book can cost $0)
# Click ✨ Start a Book
```

> **First run:** AuthorAgent generates a vault encryption key and stores it **outside the repo** (`%LOCALAPPDATA%\AuthorClaw\vault.key` on Windows, `~/.authorclaw/vault.key` elsewhere) so your encrypted API keys never sync to cloud drives. The Getting Started checklist on the home screen walks you through the rest.

See [QUICKSTART.md](QUICKSTART.md) for the full guide.

## AI Providers — bring your own model

| Provider | Tier | Notes |
|---|---|---|
| Ollama | FREE (local) | Fully offline writing |
| Google Gemini | FREE | The whole pipeline can run on this |
| DeepSeek | Cheap | Strong drafting value |
| Anthropic Claude | Premium | Best editing/judging |
| OpenAI | Premium | Alternative premium |
| OpenRouter | Flexible | One key, dozens of models |

Per-stage cost routing is automatic: outlines and research use free models, drafting uses mid-tier, final polish and judging use premium — and every provider's **model is a setting, not code** (Settings → AI Models), so new models are a dropdown away with cost tracking that follows the model.

## Dashboard

Six panels, no clutter:

- **Home** — Start a Book, writing momentum (streak/words), your active books with "Continue writing →", getting-started checklist
- **Books** — your library; each book opens the journey view
- **Personas** — pen names, voices, per-persona activity
- **Library** — uploads and compiled outputs
- **Tools** — every tool available standalone (Revise & Critique / Craft / Publishing & Marketing) for one-off use outside a book
- **Settings** — Connections, Integrations, Automation, Data & Memory, Preferences

## Security

- **Vault**: AES-256-GCM encrypted keys (scrypt KDF), key stored outside the repo and outside cloud-sync folders
- **Path sandbox**: single hardened path-safety module on every file route
- **Injection detection**: scoped so your *fiction* never gets blocked ("You are now in the throne room" is prose, not an attack)
- **Audit log**: JSONL trail of every agent action
- **Localhost only**: binds to 127.0.0.1 — nothing exposed
- **Skill/write protections**: confirmation gates on external actions

For VM/VPS/Docker deployment (recommended for always-on Telegram use), see [SECURITY.md](SECURITY.md) and the `docker/` directory.

## Development

```bash
npm run check   # typecheck + 410 tests
npm run dev     # auto-reload dev server
```

The codebase is modular TypeScript: domain-split API routes (`gateway/src/api/routes/`), service container, message pipeline, and a vitest suite covering the security, routing, memory, and quality subsystems.

## Contributing

Contributions welcome — new skills (`skills/*/SKILL.md`, YAML frontmatter + markdown), bug fixes, new providers, bridges, dashboard improvements, docs. Fork → feature branch → `npm run check` → PR.

## Disclaimer

Provided "as is," use at your own risk. AI output should always be reviewed by a human before publishing. Third-party AI usage is subject to those providers' terms and pricing; API costs are your responsibility.

## License

MIT. See [LICENSE](LICENSE).

Built by an author, for authors — on the belief that AI should amplify creativity, not replace it, and that your agent should work for your book, not for a subscription.
