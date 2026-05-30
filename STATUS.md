# AuthorClaw — Session Status

_Last updated: 2026-05-30_

## What this is

A handoff file for resuming work on AuthorClaw between sessions. Source of truth for *where we are*; the memory entry under `/home/paul/.claude/projects/-home-paul-data-dev-authorclaw/memory/` points here.

The actual feature backlog lives in [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) — this file only tracks the *current in-flight task*.

## How to resume

1. Read this file.
2. Read [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) to confirm state.
3. Security review **6 items DONE** (2026-05-30): auth, CORS, source-IP allowlist (`AUTHORCLAW_ALLOWED_IPS`), Helmet CSP, the confirmation-gate "local requester" audit, and the hardcoded-`127.0.0.1`/`localhost` re-audit — see [`docs/COMPLETED.md`](docs/COMPLETED.md). **Two items investigated then deferred** (2026-05-30): API-level rate limiting, and audit logging (source IP + native Linux log manager) — designs captured in `docs/TODO.md`, implementations parked at the user's direction.
4. **No item is currently in-flight.** Remaining actionable items (user to pick): **outbound egress posture** and **vault key on a multi-host Docker volume** — both audits. The token-readable-from-dashboard finding is **accepted** for the home-LAN threat model (no work unless the deployment posture changes). Resume any item via the investigate → present options → implement pattern.

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
| **Security review item #1 — auth** | ✅ **done (2026-05-30)** | Bearer token; implemented + smoke-tested. See `docs/COMPLETED.md` |
| **Security review item #2 — CORS** | ✅ **done (2026-05-30)** | Deny-by-default + `AUTHORCLAW_CORS_ORIGINS` allowlist + logged `*` escape hatch; smoke-tested (Phase 3) |
| **Source-IP allowlist (`AUTHORCLAW_ALLOWED_IPS`)** | ✅ **done (2026-05-30)** | Unset=allow-all + notice; loopback always allowed; opt-in `AUTHORCLAW_TRUST_PROXY`; `ipaddr.js` CIDR matching; gate in front of auth; smoke-tested (Phase 4) |
| **Helmet CSP** | ✅ **done (2026-05-30)** | `connectSrc: ["'self'"]` (dashboard is same-origin only); `upgradeInsecureRequests` kept off (HTTP-on-LAN); smoke-tested (Phase 1, +2 checks → 18) |
| **Confirmation-gate "local requester" audit** | ✅ **done (2026-05-30)** | No active vuln (gate never trusts IP/loopback; approval only via auth-gated `/api/*`, no bridge/WS path). Fixed one stale docstring asserting the old `127.0.0.1`-bind protection. See `docs/COMPLETED.md` |
| **Hardcoded `127.0.0.1`/`localhost` re-audit** | ✅ **done (2026-05-30)** | Fixed 2 findings: stale "unauthenticated/localhost is acceptable" comment in `routes.ts`; **Telegram bridge self-calls to `/api/*` sent no token → 401 under auth (functional regression from item #1)** — added `apiHeaders()` token injection to all 6 + the `index.ts` /export self-call. tsc clean; 18 smoke checks pass. See `docs/COMPLETED.md` |
| **Audit logging (source IP + native Linux log manager)** | ⏸️ **deferred (2026-05-30)** | Design captured. Docker has no in-container journald/syslog → stdout-to-platform-driver is the cross-env mechanism; add as a 2nd sink beside the hash-chained JSONL; off-switch on the native sink. See `docs/TODO.md` |
| **API-level rate limiting** | ⏸️ **deferred (2026-05-30)** | Design settled (auth-aware + exempt trusted IPs; won't throttle MCP), implementation parked. Chat path already limited 30/min/channel via `permissions.ts` (inherited from OpenClaw); gap is REST `/api/*`. OpenClaw has no `/api/*` limiting. See `docs/TODO.md` |
| Security review remaining (actionable) items: egress, vault volume | ⬜ pending | User to pick next. See `docs/TODO.md` "Full security review" section |
| Security review accepted (no work): token-readable-from-dashboard | ✅ accepted | Within home-LAN threat model; close via `AUTHORCLAW_ALLOWED_IPS`/firewall if posture changes |
| Pending plans, Larger items | ⬜ pending | See `docs/TODO.md` |

## Open questions (security item #1) — ANSWERED 2026-05-30

All four resolved by the user; all matched the prior leans.

1. **Missing-token startup behavior:** ✅ **auto-generate-and-persist to `.env`** (matches the existing `AUTHORCLAW_VAULT_KEY` pattern, zero-config).
2. **No-auth escape hatch:** ✅ **include `AUTHORCLAW_AUTH_DISABLED=1`** with a loud startup warning.
3. **Token storage:** ✅ **plain `AUTHORCLAW_AUTH_TOKEN` in `.env`** alongside `AUTHORCLAW_VAULT_KEY` (dashboard injection needs plaintext at request time).
4. **Telegram/Discord bridges:** ✅ **leave them alone** (they have their own platform auth).

Item #1 is now fully unblocked — implement per **What still ought to happen** below.

## Decisions made this session (don't re-litigate)

- **Version is `5.0.0`** as the new-fork baseline. `package.json`, `package-lock.json`, `gateway/src/index.ts:203` banner, and `docs/QUICKSTART.md:28` all aligned.
- **Workflow:** every feature in flight must be in `docs/TODO.md`. On completion, items move to `docs/COMPLETED.md` with a `YYYY-MM-DD` heading — don't just check the box and leave them.
- **Karpathy AI Coding Guidelines** in `CLAUDE.md` are mandatory: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. They override conflicting habits/defaults.
- **Windows-direct is no longer supported.** Windows users routed via Docker Desktop or WSL2. `process.platform === 'win32'` branches in source are inherited from OpenClaw and left intact (no code surgery). `LAUNCH-GUIDE.md` updated accordingly.
- **`npm run build` is required** — `docker/Dockerfile` stage 1 runs `tsc`, stage 2 runs `node dist/gateway/src/index.js`. Don't simplify away.
- **OpenClaw references are all intentional** (fork attribution + "inspired by" feature credits + roadmap analysis docs). Don't scrub.
- **Security item #1 approach:** Option (A) — bearer token in env var. Options (B) HMAC and (C) mTLS were rejected as disproportionate to the threat model (single-user home LAN, occasional family curiosity).
- **Git workflow:** I write the commit message to a file named `commit_message` in the project root. User handles `git push`. Latest commit is `e531952`. The `commit_message` file from that commit remains in the working tree (untracked) — user can delete or `.gitignore` it.

## Item #1 — DONE (2026-05-30)

Bearer-token auth implemented and smoke-tested. Full implementation + verification notes in [`docs/COMPLETED.md`](docs/COMPLETED.md). Key facts for follow-on items:

- Token lives in `.env` as `AUTHORCLAW_AUTH_TOKEN` (auto-generated on first start). `.env` is gitignored; the smoke test's generated token was removed on cleanup — it regenerates on the next real `npm start`.
- Gate is on `this.authToken` (`gateway/src/index.ts`): `null` = disabled (`AUTHORCLAW_AUTH_DISABLED=1`), string = enforced. Express middleware (constructor) and `io.use()` (`setupWebSocket`) both read it.
- Native-element GETs (img/href/Audio in the dashboard) authenticate via `?token=` query fallback, not the header.
- **Repeatable verification:** `npm run test:smoke` (`tests/smoke-test.sh`) boots the gateway and asserts auth, CORS, **and the source-IP allowlist** (16 checks across 4 phases). Re-run it after any change to auth, CORS, the IP gate, the dashboard fetch path, or startup. Per the `CLAUDE.md` `## Testing` directive, future security items should add their own assertions here rather than relying on manual curl runs.

## Item #2 — DONE (2026-05-30)

CORS tightened. Full notes in [`docs/COMPLETED.md`](docs/COMPLETED.md). Key facts:

- Shared `corsOptions` (one origin-callback) applied to both Express (`cors(corsOptions)`) and the Socket.IO server. Computed in the constructor from `AUTHORCLAW_CORS_ORIGINS`; posture stored in `this.corsSummary`/`this.corsWildcard` and logged in Phase 2c.
- Default (unset) = **deny cross-origin**; comma-separated list = override; literal `*` = permissive escape hatch (logged `⚠`). No-Origin requests (curl/MCP/same-origin) always allowed.
- Smoke test Phase 1 asserts default-deny; Phase 3 asserts allowlist echo + unlisted-deny.

## Source-IP allowlist — DONE (2026-05-30)

Full notes in [`docs/COMPLETED.md`](docs/COMPLETED.md). Key facts for follow-on items:

- Env: `AUTHORCLAW_ALLOWED_IPS` (comma-separated IPs/CIDRs; unset = allow all + `ℹ` notice; loopback always allowed when enforcing). `AUTHORCLAW_TRUST_PROXY=1` reads the client IP from `X-Forwarded-For` (off by default; spoofable unless behind a sole-ingress proxy).
- `gateway/src/index.ts`: `this.allowedIps` (`ipaddr.js` `[addr, prefix]` tuples), `isIpAllowed()`, `socketClientIp()`. Express gate (403 + audit `ip_blocked`) and `io.use()` gate both sit **in front of** the auth gate. `ipaddr.js` is now a direct dep.
- **Docker caveat (important):** default bridge + published port masks source IPs (container sees `172.x` for all external clients). For real per-IP enforcement use the host firewall / provider security group, or run host-net / behind a proxy with `AUTHORCLAW_TRUST_PROXY=1`. This is the most robust control for the VPS "only my home IP" case.
- Smoke test Phase 4 (trust-proxy on) asserts exact-IP allow, CIDR allow, unlisted → 403 (proving the gate precedes auth), loopback recovery, and the enforcement log.

## Helmet CSP — DONE (2026-05-30)

Full notes in [`docs/COMPLETED.md`](docs/COMPLETED.md). Key facts:

- `connectSrc: ["'self'"]` in the constructor `helmet({ contentSecurityPolicy: … })` block (`gateway/src/index.ts`). Investigation confirmed the dashboard is same-origin only (`var API = ''`), loads no external subresources, and opens no browser WebSocket — so `'self'` is exact, not a compromise. **CSP governs the browser dashboard only; MCP/server-to-server clients are unaffected by it** (relevant to the planned AuthorClaw MCP server — see TODO).
- `upgradeInsecureRequests: null` (off) kept deliberately — the server speaks plain HTTP on the LAN; flip to `{}` once an HTTPS/reverse-proxy deployment is recommended.
- Smoke test Phase 1 (+2 checks, now 18): `connect-src` is exactly `'self'` and has no permissive `*`. New `rheader` helper reads arbitrary response headers.

## API-level rate limiting — DEFERRED (2026-05-30)

Investigated and parked at lower priority. Full context (what already exists, OpenClaw provenance, the settled design, the one open implementation choice) is in `docs/TODO.md` under the deferred bullet. Short version: the chat path is already limited (30/min/channel, `permissions.ts`, inherited from OpenClaw); the gap is REST `/api/*`, which OpenClaw never limited either (localhost-only design). Design is decided (auth-aware + exempt trusted IPs, won't throttle MCP); only `express-rate-limit`-vs-hand-rolled remains open.

## Confirmation-gate "local requester" audit — DONE (2026-05-30)

No active vulnerability. The gate never grants on source IP / loopback (no `req.ip`/`127.0.0.1` check anywhere); approval is reachable only via the auth-gated `POST /api/confirmations/:id/approve` (sole caller), with no bridge or WebSocket approval path. One stale docstring (`confirmation-gate.ts:194`) claimed approval was safe because the server "binds to 127.0.0.1" — corrected to state the real model (bearer token is the trust boundary, not the bind address). Full notes + two cross-references (`decidedBy` hardcoded `'user'`; gate protection rests on the `/`-extractable token) in `docs/COMPLETED.md`.

## Audit logging (source IP + native Linux log manager) — DEFERRED (2026-05-30)

Investigated and parked at the user's direction. Full context in `docs/TODO.md` under the deferred bullet. Short version: the new ask is to route audit events to the native Linux log manager (journald/syslog) with an off switch, plus the original source-IP enrichment. **Key finding:** Docker (`node:22-slim`) has no in-container journald/syslog, so the cross-environment mechanism is **structured stdout/stderr → platform log driver** (journald under systemd; Docker `logging: driver: journald|syslog` forwards to the host). Add it as a **second sink** beside the existing hash-chained JSONL (`gateway/src/security/audit.ts`), with an off-switch on the native sink. Open decisions (mechanism, JSONL fate, off-switch scope) recorded in TODO.

## What still ought to happen (next session) — user picks the next item

No item is in-flight. Both audit logging and rate limiting are deferred (designs captured). Two actionable security items remain, either resumable via investigate → present options → implement:

1. **Outbound egress posture** — audit the server-side AI/research egress path (not CSP): which outbound hosts the AI router + `ResearchGate` reach, and whether anything constrains them.
2. **Vault key on a multi-host Docker volume** — verify `vault.enc` perms survive volume mounts; document `AUTHORCLAW_VAULT_KEY` backup/restore (mostly operational/docs).

Everything done this session is committed-message-ready in `commit_message` (working tree; user handles `git push`).

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
