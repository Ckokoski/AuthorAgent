# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What AuthorClaw is

A localhost-only Node.js/TypeScript writing-agent gateway. One process runs an Express + Socket.IO server on `127.0.0.1:3847`, serves a single-file dashboard, exposes a REST + WebSocket API, and optionally bridges to Telegram/Discord. The agent autonomously executes "projects" (multi-step writing pipelines: planning → bible → production → revision → format → launch) by chaining AI calls and injecting skill content into each step's prompt.

There is **no unit-test suite** (the only automated test is a startup + auth **smoke test**, `tests/smoke-test.sh` — see [Testing](#testing)), no compile step in dev (TypeScript runs through `tsx`), and **no `git push` workflow** — the parent `/home/paul/data/dev/CLAUDE.md` requires writing commit messages to a `commit_message` file in the repo root and letting the user handle pushes.

## Feature tracking workflow

All features for this project are tracked in two files:

- **`docs/TODO.md`** — every pending feature, cleanup, investigation, and larger item. Anything currently being worked on must appear here.
- **`docs/COMPLETED.md`** — items moved out of `TODO.md` once finished, with a completion date.

Rules for Claude:

- **Every feature the user is working on must be in `docs/TODO.md`.** When the user describes new work that is not already listed, **prompt them to add it to the TODO before starting** — do not silently begin work on an untracked item.
- **On completion**, move the item from `docs/TODO.md` to `docs/COMPLETED.md`. Do not just check the box and leave it in `TODO.md`. Preserve the original bullet text, prepend a completion date (`YYYY-MM-DD`), and remove it from `TODO.md` in the same edit.
- Match the existing TODO grouping when adding new entries (e.g. "Quick cleanups", "Investigations", "Larger items"). If no group fits, create one rather than dumping into a misleading bucket.

## Karpathy AI Coding Guidelines

**These directives are MANDATORY and apply to every coding task, in every project, without exception.** They are not suggestions, defaults, or tie-breakers — they override conflicting habits, training defaults, and stylistic preferences. Follow all four at all times:

- Apply them to every response that writes, edits, reviews, or plans code — no matter how small the change.
- Do not skip, soften, or abbreviate them under time pressure, token pressure, or user urgency.
- If a user request appears to conflict with these directives, surface the conflict explicitly and ask before proceeding — do not silently deviate.
- Before submitting any code change, self-check against all four sections below. If any check fails, revise before responding.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Commands

```bash
npm start              # node --import tsx gateway/src/index.ts
npm run dev            # same, with --watch (file reload)
npx tsc --noEmit       # type-check only (no emit; nothing reads dist in dev)
npm run build          # tsc emit to dist/ — consumed by docker/Dockerfile stage-1 builder; production image runs `node dist/gateway/src/index.js`
npm run setup          # interactive setup wizard
npm run security-audit # runs scripts/security-check.js
npm run docker:up      # docker-compose up -d (uses docker/docker-compose.yml)
npm run test:smoke     # boot the gateway + assert auth is enforced (tests/smoke-test.sh; -v streams the server log)
```

No lint runner and no unit-test runner are configured. The scripted tests live in `tests/` (currently just the smoke test) — see [Testing](#testing). Don't invent other test commands.

Ad-hoc liveness checks (the smoke test already covers these as assertions):
```bash
curl http://localhost:3847/api/status        # liveness (401 unless auth disabled or a bearer token is sent)
curl http://localhost:3847/api/projects/list # project state
```

## Testing

**Tests must be scripted so they can be repeated.** Any check worth running is worth committing as a runnable script under `tests/`. When you verify behaviour by hand (curl sequences, startup checks, status-code assertions), capture it as a script before considering the work done — do not leave verification as one-off shell commands in a transcript that the next session can't re-run.

**Debug logging must be available for testing.** Tests and the code they exercise must expose a way to surface verbose/debug output so a failing run can be diagnosed without re-instrumenting the code — for example a `-v` flag on a test script that streams the captured server log, or a debug log level on the service under test.

Current scripted tests:

- `tests/smoke-test.sh` (`npm run test:smoke`) — boots the gateway and asserts the security perimeter across 4 phases (16 checks). **Auth:** `401` without a token, `200` with a valid bearer, `200` via the `?token=` query fallback, `401` on a wrong token, dashboard token injection, and the `AUTHORCLAW_AUTH_DISABLED=1` escape hatch. **CORS:** cross-origin denied by default, and with `AUTHORCLAW_CORS_ORIGINS` set a listed origin is echoed while an unlisted one is not. **Source-IP allowlist** (with `AUTHORCLAW_TRUST_PROXY=1` so the client IP is driven via `X-Forwarded-For`): exact IP and CIDR members allowed, unlisted IP → `403` even with a valid token (the gate sits in front of auth), and loopback always allowed. Hermetic and non-destructive: supplies the token via env (no `.env` write), binds loopback only, and leaves no stray process. Run `tests/smoke-test.sh -v` to stream the server log.

## High-level architecture

### Entry point and wiring

`gateway/src/index.ts` is **the** entry point — a single ~2,650-line `AuthorClawGateway` class that owns every service instance and wires them together in a numbered init sequence (Phase 1: config → Phase 2: security → Phase 3: soul/memory → Phase 4: AI providers → Phase 5: research gate → Phase 6: skills → Phase 6b-k: ~30 feature services → finally start HTTP + Socket.IO). When adding a new service, follow the existing pattern: instantiate it in a Phase block, wire its dependencies via setter methods (not constructor injection), and pass it through to `createAPIRoutes()` if it needs HTTP endpoints.

REST routes live in `gateway/src/api/routes.ts` (~5,500 lines) — a single factory function that mounts everything onto an Express router. Dashboard is `dashboard/dist/index.html` (single ~3,800-line HTML file with inline JS, served statically).

### Three concentric layers

1. **Security perimeter** (`gateway/src/security/`):
   - `Vault` — AES-256-GCM credential store at `config/.vault/vault.enc`. Master key from `AUTHORCLAW_VAULT_KEY` env var; auto-generated into `.env` on first run if missing.
   - `SandboxGuard` — enforces that all file access stays under `workspace/`.
   - `InjectionDetector` — pattern-matches inbound user messages for prompt-injection attempts.
   - `AuditLog` — JSONL daily logs under `workspace/.audit/`.
   - `PermissionManager` — preset-based gating ("standard" by default).
   - `ConfirmationGateService` (services/) — universal approval gate for every Wave 3 irreversible action (publish, send, submit, upload, bid, purchase). 24h expiry. See `SECURITY.md` — do not bypass this for any new external-side-effect feature.

2. **AI routing** (`gateway/src/ai/router.ts`):
   - 6 providers: Ollama (free local), Gemini (free), DeepSeek (cheap), Claude, OpenAI, OpenRouter.
   - Task types map to tiers (`free` / `mid` / `premium`) which map to ordered provider preference lists. `TASK_TIERS`, `TIER_ROUTING`, `TASK_REASONING`, and `TASK_OUTPUT_BUDGET` constants at the top of `router.ts` are the source of truth.
   - **Output budget matters**: tasks like `outline`, `book_bible`, `creative_writing` need 16K tokens — under-budgeting silently truncates output and breaks downstream pipeline steps. Don't lower these without understanding the failure mode they exist to prevent.
   - Reasoning effort (`thinking: low|medium|high`) gets translated per provider (Claude thinking budget, Gemini `thinkingConfig`, DeepSeek model swap to `deepseek-reasoner`, OpenAI `reasoning.effort`). Ignored silently on providers that don't support it.

3. **Skills + Projects** (the autonomous loop):
   - **Skills** are markdown files at `skills/<category>/<name>/SKILL.md` with YAML frontmatter (`description`, `triggers`, `permissions`). Categories: `core`, `author`, `marketing`, `ops`, `premium` (gitignored — purchased separately). `SkillLoader` parses frontmatter, stores full content, and matches by trigger-keyword substring. Synthetic skills can also be registered at runtime from discovered Author OS tools.
   - **ProjectEngine** (`services/projects.ts`, ~2,400 lines) owns 6 hardcoded project templates plus a `novel-pipeline` that chains all 6 phases. A "project" is a sequence of `ProjectStep`s, each with a `taskType` (routes to a tier), a `prompt`, an optional `skill` (whose content gets injected), and an optional `wordCountTarget` (triggers multi-pass continuation when the LLM runs out of room). When no template matches, the engine asks the AI to plan steps dynamically from the skill catalog.
   - Projects auto-execute on creation. Outputs land in `workspace/projects/<project-id>/`. Completion hooks fire `onProjectCompleted` callbacks — currently used for the website auto-add-book hook, user-model observation, and auto-skill drafting.

### Stateful directories

Everything user-generated lives under `workspace/` (entirely gitignored except the dir itself):
- `workspace/soul/` — SOUL.md, STYLE-GUIDE.md, VOICE-PROFILE.md (author identity, prompt-injected)
- `workspace/memory/` — conversation history, book bible, summaries, lessons, preferences
- `workspace/projects/<id>/` — project outputs (markdown per step + compiled DOCX/EPUB)
- `workspace/documents/` — uploaded large manuscripts (>15K words); excerpts get sent to AI, full text stays on disk
- `workspace/.config/` — `personas.json`, `projects-state.json` (persistent state)
- `workspace/.activity/` — universal activity log (JSONL), surfaced to dashboard
- `workspace/.audit/` — security audit log (JSONL)
- `workspace/.agent/` — agent journal, self-improvement notes
- `workspace/.vault/` — see above
- `workspace/audio/` — generated TTS files, auto-cleaned after 24h

`config/default.json` is the only versioned config; `config/user.json` overrides it and is gitignored.

### Bridges

`gateway/src/bridges/{telegram,discord}.ts` translate channel-specific commands (`/novel`, `/project`, `/write`, `/files`, `/read`, `/export`, `/speak`, `/voice`, etc.) into calls against the same internal handlers used by the dashboard chat. Conversation history is keyed by channel name to prevent cross-contamination between Telegram users, web chat, and API callers — preserve this when touching `conversationHistories` in `index.ts`.

## Conventions specific to this repo

- **Imports use `.js` extensions** even though source is `.ts` — required by the `NodeNext` module resolution in `tsconfig.json`. Match this when adding files.
- **Node 22+** required (`engines` in `package.json`); `--import tsx` is how TS is loaded — don't switch to `ts-node`.
- **Server bind is configurable via `AUTHORCLAW_BIND` env var, defaulting to `0.0.0.0`** (changed from hardcoded `127.0.0.1` so the published Docker port is reachable on the LAN). To restore the old behavior, set `AUTHORCLAW_BIND=127.0.0.1`. (Helmet `connectSrc` is still permissive `*` pending the Helmet-CSP security item; `SECURITY.md`/README localhost-only language is stale — update when next touched.)
- **Security perimeter env vars** (from the security review — see `docs/COMPLETED.md`). Each is opt-out or opt-in via env; the constructor wires them and startup logs the posture:
  - `AUTHORCLAW_AUTH_TOKEN` — bearer token gating `/api/*` + the Socket.IO handshake. Auto-generated into `.env` on first run; `AUTHORCLAW_AUTH_DISABLED=1` turns auth off (loud warning). Native-element GETs use a `?token=` query fallback.
  - `AUTHORCLAW_CORS_ORIGINS` — comma-separated browser-origin allowlist (Express + Socket.IO). **Unset = deny all cross-origin** (dashboard is same-origin, unaffected); a literal `*` restores permissive CORS (logged).
  - `AUTHORCLAW_ALLOWED_IPS` — comma-separated source IPs/CIDRs gating *all* clients, in front of auth. **Unset = allow all** (notice logged); loopback always allowed. `AUTHORCLAW_TRUST_PROXY=1` reads the client IP from `X-Forwarded-For` (only safe behind a sole-ingress proxy). **Docker caveat:** default bridge + published port masks source IPs — enforce at the host firewall / provider security group, or use host-net / a trusted proxy, for real per-IP control.
- **Errors during init are logged with `console.log('  ✓ …')` / `'  ⚠ …'` / `'  ℹ …'`** and the gateway continues with degraded capability when a service can't initialize (e.g. memory-search if `better-sqlite3` won't build, video-research if `yt-dlp` is missing). Preserve this fail-soft pattern — don't make startup require optional dependencies.
- **Premium skills are gitignored** (`skills/premium/*/`) — never commit them. The folder ships only with a `README.md`.
- **Workspace runtime data is gitignored** but the directory must exist; the gateway creates subdirs on init.
- The parent `/home/paul/data/dev/CLAUDE.md` applies: surgical changes only, no speculative abstractions, ask before system-level changes, write commit messages to a `commit_message` file rather than committing directly.

## Things that look broken but aren't

- `OpenClaw` references in code and comments come from this being a fork of OpenClaw — they're not separate components. Two kinds appear: fork attribution (file headers, banner, `package.json` keyword) and "Inspired by OpenClaw …" credits on specific features (TTS, thinking-budget knobs, browser-doctor probe). Both are intentional.
