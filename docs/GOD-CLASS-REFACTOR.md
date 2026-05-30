# The God Class Problem — Analysis and Three-Level Refactor Plan

A standing architectural debt in AuthorClaw: two files (`gateway/src/index.ts` and `gateway/src/api/routes.ts`) own the wiring for the entire system. Together they're ~8,200 lines of intertwined initialization and routing that every new feature has to touch.

This document quantifies the problem, compares it to OpenClaw's plugin architecture (which decisively does **not** have this issue), and lays out a three-level incremental refactor — each level individually shippable.

Last analysis: 2026-05-28.

---

## The numbers

`TODO.md` had rough estimates. Direct measurement of the current tree:

| Metric | TODO.md estimate | Actual (2026-05-28) |
|---|---|---|
| `gateway/src/index.ts` lines | ~2,650 | **2,649** ✓ |
| Single class declared | `AuthorClawGateway` | `AuthorClawGateway` ✓ |
| Services instantiated as `this.X = new …` | ~50 | **61** |
| Methods on the god class | (not stated) | **77** |
| Numbered init phases | (not stated) | **35** (Phase 1 → Phase 11, with sub-phases 6a–6k) |
| Duplicate phase labels | (not stated) | **Yes — two distinct blocks both labeled `Phase 6h`** (line 476 = website management; line 550 = orchestrator). This is a smell of how chaotic the phase sequence has grown. |
| `gateway/src/api/routes.ts` lines | ~5,500 | **5,516** ✓ |
| Endpoints in a single function | (not stated) | **234 `app.<verb>()` calls — all inside one `createAPIRoutes(app, gateway)`** |

Both files match the textbook god-class shape: one constructor (or one factory function) knows about every subsystem, and every new feature compounds the pressure on the same file.

### Why this is the day-to-day cost, not a theoretical one
1. **Merge conflicts** — any two parallel branches that add features will both touch `index.ts` and `routes.ts`.
2. **Cognitive load** — finding the cron-scheduler init means scrolling past 2,000 lines of unrelated wiring.
3. **Testability** — `AuthorClawGateway` constructs everything itself. There's no seam to inject a fake `Vault` or mock `AIRouter` for a unit test.
4. **Hidden coupling** — services reach into other services via `gateway.foo.bar()`. Cross-cutting concerns (audit, sandbox, vault) become god-pointers from a top-level object instead of explicit dependencies.
5. **The "two `6h`" symptom** — the numbered phase sequence has overflowed. New init blocks are being shoehorned into adjacent numbers because there's no natural place to put them.

---

## Does OpenClaw have the same problem?

**No — decisively no.** They architecturally precluded it.

OpenClaw is a **pnpm monorepo** (`package.json` version `2026.5.28`, `type: "module"`) with three clean tiers:

### `packages/` — 7 SDK packages
- `agent-core` — core agent functionality
- `gateway-client` — client for gateway communication
- `gateway-protocol` — protocol definitions
- `memory-host-sdk` — SDK for memory host integration
- `plugin-package-contract` — contract/interface plugins implement
- `plugin-sdk` — SDK for plugin development (exposes ~200 granular subpath exports covering runtime abstractions for `channel`/`agent`/`provider`, configuration, media, transcripts, embeddings, SSRF, secrets, auth, logging)
- `sdk` — main SDK package

### `extensions/` — ~150 bundled plugins, each in its own folder
Broken down roughly by category:
- ~40 LLM provider adapters (Anthropic, OpenAI, Google, Mistral, Groq, DeepSeek, Qwen, Ollama, LiteLLM, HuggingFace, AWS Bedrock, Azure, …)
- ~20 messaging-channel adapters (Discord, Slack, Teams, Matrix, IRC, Signal, Telegram, Mattermost, Google Chat, Feishu, …)
- ~10 web/search tools (Browser, Brave, DuckDuckGo, Exa, Firecrawl, SearXNG)
- ~15 media handlers (image gen, video — Runway, Pixverse — document extraction, audio — ElevenLabs, Deepgram)
- ~20 developer tools (GitHub Copilot, OpenCode, Codex, language packs, diagnostics)
- ~5 storage/memory (`memory-core`, `memory-lancedb`, `memory-wiki`, `active-memory`)
- ~25 specialized services (databases, device pairing, file transfer, phone control, policy management)

### `apps/` — separate native app shells
`macos`, `ios`, `android`, `macos-mlx-tts`, plus `shared/OpenClawKit` and `swabble`.

### The architectural delta
Where AuthorClaw has *one* `AIRouter` class with 60 siblings inside `AuthorClawGateway`, OpenClaw has a **plugin contract** (`plugin-package-contract`) and every provider is a folder under `extensions/` that **registers itself** against that contract. The core gateway only knows how to *load plugins via the contract* — it doesn't `new` each one.

That's why OpenClaw's gateway core doesn't accumulate god-class mass even at 5× AuthorClaw's surface area. Adding a new provider/channel/tool in OpenClaw is creating a folder under `extensions/`. Adding one in AuthorClaw is editing `index.ts`.

The decision to pay for a plugin SDK up front is what kept their core gateway clean. AuthorClaw's path was different — fast feature velocity inside a single class — and now it's paying interest on that decision every time a new service shows up.

---

## The three-level refactor plan

Each level is individually shippable and unlocks the next. You don't need to commit to Level 3 to get value from Level 1.

### Level 1 — Phase extraction (1–2 days, low risk)

**Goal:** Turn `index.ts` from a 2,649-line monolith into a thin ~300-line composition root.

**What to do:**
Each numbered Phase block in `index.ts` becomes a module under `gateway/src/init/`:

```
gateway/src/init/
  01-config.ts            export async function initConfig(): ConfigService
  02-security.ts          export async function initSecurity(config): SecurityServices
  02b-activity-log.ts
  03-soul-memory.ts       export async function initSoulMemory(config)
  03b-memory-search.ts
  04-ai-providers.ts      export async function initAI(config, vault, costs): AIServices
  05-research.ts
  06a-skills.ts
  06b-author-os.ts
  06c-tts.ts
  06c2-image-gen.ts
  06d-personas.ts
  06e-project-engine.ts
  06f-context-engine.ts
  06g-lessons-prefs.ts
  06g2-user-model.ts
  06g3-cron.ts
  06g4-auto-skill.ts
  06g5-writing-judge.ts
  06g6-research-services.ts
  06g7-story-structures.ts
  06g8-plot-promises.ts
  06g9-character-voices.ts
  06h-website.ts
  06h2-orchestrator.ts    ← rename to resolve the duplicate-6h issue
  06i-export-feedback.ts
  06j-wave2.ts
  06k-wave3.ts
  07-heartbeat.ts
  08-bridges.ts
  09-api-routes.ts
  10-websocket.ts
  11-static-dashboard.ts
```

The `AuthorClawGateway` constructor becomes a sequence:

```typescript
const config = await initConfig();
const security = await initSecurity(config);
const soulMemory = await initSoulMemory(config);
const ai = await initAI(config, security.vault, security.costs);
// ... etc
const services = { config, ...security, ...soulMemory, ...ai, /* ... */ };
this.services = services;
```

**What this does NOT change:**
- The total number of services (still 61).
- The interfaces between services (still the same constructors).
- Any tests (there aren't any to break).

**What this DOES change:**
- Blast radius. Editing the cron scheduler init no longer requires scrolling past 2,000 lines of unrelated wiring.
- Merge conflicts. Two parallel feature branches no longer collide on `index.ts`.
- The two-`6h` smell — the rename to `06h` and `06h2` fixes it as part of the move.

**Risk:** Very low. File moves with mechanical refactoring. No API changes, no behavior changes. If the AuthorClaw codebase had even one passing test, this would be the easiest review you've ever done.

**Same pattern for `routes.ts`:**
Split `createAPIRoutes(app, gateway)` into one mounter per feature area:

```
gateway/src/api/routes/
  projects.routes.ts
  personas.routes.ts
  pipeline.routes.ts
  vault.routes.ts
  voice.routes.ts
  research.routes.ts
  website.routes.ts
  wave3.routes.ts
  documents.routes.ts
  status.routes.ts
```

Each file exports a `mountX(app, gateway)` function. The top-level `createAPIRoutes` becomes a ~20-line file that imports and calls each mounter. ~234 endpoints become ~25 per file instead of all 234 in one.

---

### Level 2 — Service registry (~1 week, medium risk)

**Goal:** Stop using `gateway.foo.bar()` as a god-pointer. Make dependencies explicit.

**What to do:**
Replace the `this.foo = new Foo(this.bar)` pattern with a typed service registry:

```typescript
interface ServiceRegistry {
  register<K extends keyof ServiceMap>(key: K, instance: ServiceMap[K]): void;
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K];
}

// At init:
const registry = new ServiceRegistry();
registry.register('config', await ConfigService.create(ROOT_DIR));
registry.register('vault', new Vault(registry.get('config')));
registry.register('aiRouter', new AIRouter(registry));   // services pull deps from registry
```

Services declare their dependencies in their constructor signature, the registry resolves them. The gateway becomes a *pure composition root* that wires the registry and starts the HTTP server — nothing else.

**What this unlocks:**
- **Testability.** A test can register a mock `Vault` against the registry and exercise downstream services.
- **Service swapping.** A different AI router could be registered at runtime based on config.
- **Level 3.** A plugin loader needs a registry to register loaded plugins into.

**Risk:** Medium. Touches every service's constructor signature. Worth doing only after Level 1 has landed and stabilized.

---

### Level 3 — Plugin contracts for the parts that are *actually* plugin-shaped (multi-week, higher risk)

**Goal:** Match OpenClaw's pattern where it matters, skip it where it doesn't.

**Don't plugin-ify everything.** Author skills are already plugin-shaped (markdown files in `skills/`). The project engine, heartbeat, vault, sandbox, audit — these are core infrastructure and don't gain anything from being plugins.

**Do plugin-ify the four subsystems with N-of-1 patterns where new entries arrive on a schedule:**

| Subsystem | Today | Why it should be plugin-shaped |
|---|---|---|
| **AI providers** | All 5 providers wired inline in `AIRouter` (737 lines) | New providers (Pixverse, DeepInfra, embeddings) keep arriving — see `OPENCLAW-UPDATES.md` items #5, #11, #19 |
| **Channel bridges** | Telegram (801 lines) + Discord (13 lines, basically a stub), both hardcoded in `gateway/src/bridges/` | OpenClaw has 20+ channels; `OPENCLAW-UPDATES.md` item #7 flags WhatsApp + iMessage as Tier 2 priorities |
| **Image/video gen backends** | Gemini Nano Banana wired inline in `image-gen.ts` | Pixverse video coming (`OPENCLAW-UPDATES.md` item #11); cover-typography already needs multiple backends |
| **TTS engines** | Edge TTS inline in `tts.ts` | ElevenLabs and cloud TTS will eventually be requested (`OPENCLAW-UPDATES.md` item #1 voice work depends on this) |

**Pattern for each:**
1. Define a TypeScript interface in `gateway/src/plugins/<category>/contract.ts`.
2. Move existing implementations into `gateway/src/plugins/<category>/<name>/index.ts` + a `manifest.json`.
3. Add a loader that scans the directory, reads manifests, and registers instances against the Level 2 registry.

After this, adding the next provider/channel/backend/voice is **creating a folder**, not editing `index.ts`.

**Risk:** Higher because the plugin contract is a forward-compatibility commitment. Worth scoping carefully — a bad contract is worse than no contract.

**Worth waiting for:** This refactor should happen *together with* (or just before) absorbing OpenClaw upstream channels from `OPENCLAW-UPDATES.md`. Doing the architecture and the imports in one motion is much cheaper than doing them sequentially.

---

## Recommendation

**Do Level 1 next.** It's the highest leverage for the lowest risk: bounded scope (1–2 days), no API changes, no test rewrites, just file moves and an `init/` folder. It directly resolves the merge-conflict pain that's the actual day-to-day cost of the god class. It also makes Levels 2 and 3 *possible* — right now any service-registry refactor has to fight the god class first.

**Defer Levels 2 and 3 until:**
- You've decided which OpenClaw-aligned features from `OPENCLAW-UPDATES.md` you're porting (because the Level 3 plugin architecture *is* the same architecture you'd need to absorb upstream channel adapters cleanly anyway), **and**
- You have at least a minimal test suite. The `AIRouter` and `ProjectEngine` are the two services that most justify a registry refactor for testability reasons. Both should have unit-test coverage *before* the refactor, not after, so you can verify behavior preservation.

The `TODO.md` entries for both index.ts and routes.ts should reference this document. The standing constraint *"Not a refactor to start without an explicit goal"* in TODO.md is correct — Level 1 alone needs a goal larger than tidiness to justify the change. Pair it with the next non-trivial feature that would touch `index.ts` (likely embeddings per `OPENCLAW-UPDATES.md` item #5, or a new channel per item #7) and do the refactor as a *pre-step* for that feature. That way Level 1's value compounds with the feature work.

### Steer this refactor by the North Star

The project's **North Star** (TODO.md → "North Star — the ultimate goal") is a **multi-author, multi-book studio** where books, author profiles, genre profiles, and **customizable (data-driven) pipelines** are first-class, and adding an author/genre/pipeline is configuration rather than code. That goal is the "explicit goal larger than tidiness" this refactor has been waiting for, and it shapes *how* to refactor:

- **Level 1 (phase split):** `06e-project-engine.ts` is the block most affected — it currently holds the hardcoded 6 templates + `novel-pipeline`. Extract it so there's a clean seam to later swap hardcoded templates for loaded pipeline definitions and to slot in book/author-profile/genre-profile init blocks. In the `routes.ts` split, treat the already-listed `pipeline.routes.ts` as a real feature boundary (plus future `books.routes.ts` / author-profile / genre-profile mounters).
- **Level 3 (plugin contracts):** add **pipelines as a fifth plugin-shaped subsystem** alongside AI providers, channels, image/video, and TTS. A pipeline definition (ordered steps, per-step prompt/taskType/tier/wordCount/skill) is exactly the data-driven, "new entry = new folder/file, not a code edit" shape the plugin loader exists to serve. Author and genre profiles are likewise registry-resident, not god-class members.
- **Anti-goal:** do **not** refactor in a way that further hardens the single-author (`workspace/soul/`) or hardcoded-pipeline assumptions — that spends effort moving *away* from the North Star.

---

## Related documents

- **[TODO.md](TODO.md)** — entries for the index.ts size and routes.ts size point here for the full plan
- **[OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md)** — which upstream features motivate Levels 2 and 3 (#5 embeddings, #7 WhatsApp/iMessage, #11 Pixverse, #12 ClawHub-style registry)
- **[../README.md](../README.md#documentation)** — top-level documentation index
