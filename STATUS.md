# AuthorClaw — Session Status

_Last updated: 2026-05-30_

## What this is

A handoff file for resuming work on AuthorClaw between sessions. Source of truth for *where we are*; the memory entry under `/home/paul/.claude/projects/-home-paul-data-dev-authorclaw/memory/` points here.

The actual feature backlog lives in [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) — this file only tracks the *current in-flight task*.

## How to resume

1. Read this file.
2. Read [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) to confirm state.
3. The current in-flight task is **Security review item #1: HTTP/WebSocket authentication.** Status is **paused awaiting four design decisions** — see the **Open questions** section below.
4. Once those four answers are in, implement Option (A) — bearer token — as described in the **Decisions made** section.

## Current phase

| Phase | Status | Notes |
|---|---|---|
| Project conventions established | ✅ done | CLAUDE.md has Karpathy guidelines + TODO/COMPLETED workflow |
| v5.0.0 fork bump | ✅ done | package.json, lock, banner, QUICKSTART |
| Quick cleanups bucket | ✅ done (3 items) | banner version, QUICKSTART version, loader.ts comment, LAUNCH-GUIDE Windows path, LAUNCH-GUIDE localhost stale lines |
| Investigations bucket | ✅ done (3 items) | OpenClaw refs intentional, npm-run-build needed for Docker, Windows-direct dropped in docs (option C) |
| Dependency audit (`npm audit fix`) | ✅ done | 9 CVEs resolved (3 high, 6 moderate), smoke test passed |
| README/LAUNCH-GUIDE/CLAUDE.md cleanups | ✅ done | Stale localhost claims, orphaned notes, OpenClaw note tightened, npm-build note tightened |
| New TODO entries added | ✅ done | Multi-book mgmt, Mercury Docker deploy, Playwright e2e |
| Initial commit | ✅ done | `e531952 — v5.0.0 fork bump, feature-tracking workflow, doc and dep cleanup` |
| **Security review item #1 — auth** | 🟡 **in progress (paused on 4 questions)** | See **Open questions** below |
| Security review items #2-#9 | ⬜ pending | See `docs/TODO.md` "Full security review" section |
| Pending plans, Larger items | ⬜ pending | See `docs/TODO.md` |

## Open questions (security item #1 — answer before implementing)

These were posed at the end of the prior session; the user paused to exit before answering.

1. **Missing-token startup behavior:** auto-generate-and-persist to `.env` (matches the existing `AUTHORCLAW_VAULT_KEY` pattern, zero-config) **or** hard-fail with instructions? *My lean: auto-generate.*
2. **No-auth escape hatch:** include `AUTHORCLAW_AUTH_DISABLED=1` with a loud startup warning, or no escape hatch at all? *My lean: include it.*
3. **Token storage:** plain `AUTHORCLAW_AUTH_TOKEN` in `.env` alongside `AUTHORCLAW_VAULT_KEY`, **or** put it in the encrypted vault? *My lean: `.env` — dashboard injection needs plaintext at request time anyway.*
4. **Telegram/Discord bridges:** leave them alone (they have their own platform auth), or also gate via this token? *My lean: leave alone.*

## Decisions made this session (don't re-litigate)

- **Version is `5.0.0`** as the new-fork baseline. `package.json`, `package-lock.json`, `gateway/src/index.ts:203` banner, and `docs/QUICKSTART.md:28` all aligned.
- **Workflow:** every feature in flight must be in `docs/TODO.md`. On completion, items move to `docs/COMPLETED.md` with a `YYYY-MM-DD` heading — don't just check the box and leave them.
- **Karpathy AI Coding Guidelines** in `CLAUDE.md` are mandatory: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. They override conflicting habits/defaults.
- **Windows-direct is no longer supported.** Windows users routed via Docker Desktop or WSL2. `process.platform === 'win32'` branches in source are inherited from OpenClaw and left intact (no code surgery). `LAUNCH-GUIDE.md` updated accordingly.
- **`npm run build` is required** — `docker/Dockerfile` stage 1 runs `tsc`, stage 2 runs `node dist/gateway/src/index.js`. Don't simplify away.
- **OpenClaw references are all intentional** (fork attribution + "inspired by" feature credits + roadmap analysis docs). Don't scrub.
- **Security item #1 approach:** Option (A) — bearer token in env var. Options (B) HMAC and (C) mTLS were rejected as disproportionate to the threat model (single-user home LAN, occasional family curiosity).
- **Git workflow:** I write the commit message to a file named `commit_message` in the project root. User handles `git push`. Latest commit is `e531952`. The `commit_message` file from that commit remains in the working tree (untracked) — user can delete or `.gitignore` it.

## What still ought to happen (next session)

1. **Answer the four open questions** above.
2. **Implement security item #1 (bearer token auth):**
   - Add token-loading + auto-generation in the Phase 1 / Phase 2 init block of `gateway/src/index.ts` (alongside `AUTHORCLAW_VAULT_KEY` handling).
   - Express middleware: enforce `Authorization: Bearer` on `/api/*`. Skip `/healthz`, `/`, and dashboard static assets.
   - Socket.IO: `io.use((socket, next) => { ... })` checking `socket.handshake.auth.token`.
   - Dashboard `index.html`: server-side substitution of a `__AUTHORCLAW_AUTH_TOKEN__` placeholder (intercept `/` serve before `express.static`). Update the `fetch` wrapper around `dashboard/dist/index.html:1197/1215` to prepend the header. Update Socket.IO client init to pass `{ auth: { token } }`.
   - Per Karpathy "Goal-Driven Execution": verification is a smoke test — `npm start` → without token → 401 on `/api/status` from a fresh curl, but dashboard at `/` loads and its calls succeed (because the token was injected). With `AUTHORCLAW_AUTH_DISABLED=1` (if we include it), the startup warning fires and `/api/status` returns 200 without a header.
3. **Move item #1 to `docs/COMPLETED.md`** with the implementation outcome notes.
4. **Proceed to security item #2 (tighten CORS) — same investigate → present options → implement pattern.**

## Side flags not in TODO yet (decide whether to add)

- **`workspace/SKILLS.txt` is tracked but auto-generated on every startup**, so every server start dirties the tree. The proper fix is to gitignore it and `git rm --cached`. Not yet added to TODO — user can confirm whether to add.

## Key file paths

| What | Path |
|---|---|
| Backlog | `docs/TODO.md` |
| Done log | `docs/COMPLETED.md` |
| Project conventions | `CLAUDE.md` (project-level) |
| User conventions | `/home/paul/.claude/CLAUDE.md` |
| This handoff | `STATUS.md` (this file) |
| Memory entry | `/home/paul/.claude/projects/-home-paul-data-dev-authorclaw/memory/security_review_in_flight.md` |
| Express + Socket.IO init | `gateway/src/index.ts:180-198` |
| Env-var pattern reference | `gateway/src/index.ts:2609` (existing `AUTHORCLAW_BIND` handling) |
| Dashboard fetch wrapper | `dashboard/dist/index.html:1197, 1215` |
| Dockerfile | `docker/Dockerfile` |
