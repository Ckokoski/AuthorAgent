# AuthorClaw — Session Status

_Last updated: 2026-05-30_

## What this is

A handoff file for resuming work on AuthorClaw between sessions. Source of truth for *where we are*; the memory entry under `/home/paul/.claude/projects/-home-paul-data-dev-authorclaw/memory/` points here.

The actual feature backlog lives in [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) — this file only tracks the *current in-flight task*.

## How to resume

1. Read this file.
2. Read [`docs/TODO.md`](docs/TODO.md) and [`docs/COMPLETED.md`](docs/COMPLETED.md) to confirm state.
3. Security review **items #1 (auth), #2 (CORS), and the source-IP allowlist (`AUTHORCLAW_ALLOWED_IPS`) are DONE** (2026-05-30) — see [`docs/COMPLETED.md`](docs/COMPLETED.md). The current in-flight task is **Helmet CSP** (original item #3).
4. Next item (Helmet CSP): replace `connectSrc: ["'self'", "*"]` with an allowlist matching the configured origins; reconsider `upgradeInsecureRequests: null` (keep off only while HTTP-on-LAN; flip on once a reverse-proxy/HTTPS path is recommended). Investigate which inline/script/connect sources the dashboard actually needs before tightening (the dashboard is one inline-JS HTML file). Same investigate → present options → implement pattern; add smoke-test assertions if feasible.

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
| **Helmet CSP** | 🟡 **next (in-flight task)** | Tighten `connectSrc: ["'self'","*"]`; reconsider `upgradeInsecureRequests` |
| Security review remaining items (rate limiting, gate audit, source-IP audit-log, vault volume, egress, localhost re-audit) | ⬜ pending | See `docs/TODO.md` "Full security review" section |
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

## What still ought to happen (next session) — Helmet CSP (original item #3)

1. **Investigate** what the dashboard actually loads: it's one inline-JS HTML file served same-origin, so it needs `script-src 'unsafe-inline'` (already present) and `connect-src` only for same-origin XHR/fetch (and the WebSocket, if ever used). Confirm no external script/style/font/image CDNs are referenced before tightening.
2. **Present options** before coding: replace `connectSrc: ["'self'", "*"]` with `'self'` (+ any genuinely-needed origins, perhaps driven by the same `AUTHORCLAW_CORS_ORIGINS` set); decide `upgradeInsecureRequests` (keep `null`/off while HTTP-on-LAN, document flipping it on once an HTTPS/reverse-proxy path is recommended).
3. **Implement** the tightened CSP in the constructor `helmet({ contentSecurityPolicy: … })` block (`gateway/src/index.ts`).
4. **Add a smoke-test assertion** if feasible (e.g. assert the `Content-Security-Policy` response header no longer contains `*` in `connect-src`).
5. **Move the item to `docs/COMPLETED.md`** and advance to the next item (API-level rate limiting).

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
