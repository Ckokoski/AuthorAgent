# TODO

Tracking list of items surfaced while writing CLAUDE.md. Grouped by effort.

Anything currently being worked on must appear in this list. When an item is finished, move it to [COMPLETED.md](COMPLETED.md) with a `YYYY-MM-DD` completion date — don't just check the box and leave it here.

## Pending plans (separate files)

- [ ] **[RENAME-PLAN.md](RENAME-PLAN.md)** — rename project from AuthorClaw → BookClaw. Decisions captured, runbook ready, not yet executed.

## Full security review (post-LAN-exposure)

Opening the bind from loopback to LAN turned several previously-defense-in-depth
assumptions into single points of failure. A proper security review should
cover at minimum:

- [ ] **Restore + tighten Helmet CSP.** Replace `connectSrc: ["'self'", "*"]` with an allowlist that matches the configured origins. Reconsider `upgradeInsecureRequests: null` — keep it off only while the deployment is HTTP-on-LAN; flip it back on once the reverse-proxy path becomes the recommended deployment.
- [ ] **API-level rate limiting.** Per-channel rate limiting exists for bridges (`bridges/telegram.ts`, `bridges/discord.ts`) but not for HTTP routes. Add per-IP throttling on `/api/*` and on the WebSocket message handler.
- [ ] **Audit the confirmation-gate's "local requester" assumption.** `ConfirmationGateService` was designed assuming the approver is on the same machine. Confirm nothing in the gate flow trusts source IP / loopback in a way that LAN exposure breaks.
- [ ] **Audit-log the request source IP** on every gateway HTTP route and every WebSocket connection, so a compromise is forensically traceable. `workspace/.audit/` currently logs `websocket_connected` with socket id only.
- [ ] **Vault key on a multi-host Docker volume.** Verify `config/.vault/vault.enc` permissions survive volume mounts. Document the backup-and-restore path for `AUTHORCLAW_VAULT_KEY` since losing it means losing every stored credential.
- [ ] **Outbound egress posture.** The AI router and `ResearchGate` make outbound calls to Anthropic / Gemini / OpenAI / DeepSeek / OpenRouter / allowlisted research domains. Confirm `helmet`-level CSP doesn't accidentally weaken egress controls now that `connectSrc` is `*`.
- [ ] **Re-read every place that hardcoded `127.0.0.1` / `localhost`** (CSP, CORS, websocket allowlist, bind address — all touched by the LAN patch — plus any others). Confirm no remaining assumptions silently treat localhost as a trust boundary.

## Quick cleanups (minutes)

_(empty — completed items moved to [COMPLETED.md](COMPLETED.md))_

## Investigations (under an hour each)


## Larger items (worth scoping before starting)

- [ ] **No test suite exists.** Pick the highest-leverage area to seed coverage — likely `AIRouter` (provider routing + token-budget logic) and `ProjectEngine` (step orchestration + completion hooks). Decide test runner first (`node --test` is already used in the sibling `claude-cowork-linux` project per the workspace `CLAUDE.md`).
- [ ] **`gateway/src/index.ts` is 2,649 lines, declares a single `AuthorClawGateway` class, owns 61 service instances across 35 numbered init phases (with two distinct `Phase 6h` blocks — symptom of how chaotic the sequence has grown), and exposes 77 methods.** Initialization is one numbered Phase sequence. Worth extracting the per-phase init into separate modules so the entry point becomes a thin composition root rather than a god class. Not a refactor to start without an explicit goal — note for the next time `index.ts` blocks a feature. **Full analysis, OpenClaw architecture comparison, and three-level refactor plan in [GOD-CLASS-REFACTOR.md](GOD-CLASS-REFACTOR.md).**
- [ ] **`gateway/src/api/routes.ts` is 5,516 lines.** A single `createAPIRoutes(app, gateway)` factory mounts all 234 endpoints. Split per feature area (projects, personas, vault, voice, website, wave3) once it next causes a merge conflict or readability issue. **Covered as Level 1 in [GOD-CLASS-REFACTOR.md](GOD-CLASS-REFACTOR.md) — same pattern as the `index.ts` extraction; can be done in the same sprint.**
- [ ] **`dashboard/dist/index.html` is ~3,800 lines** of HTML + inline JS. No build step. Acceptable today, but the next non-trivial UI change is the moment to introduce a real build (Vite or esbuild) and split into modules.
- [ ] **Docker-image deploy automation to Mercury (test server).** Today the project has `docker/Dockerfile` and `docker/docker-compose.yml` but no automated path from "commit on neptune" to "running container on mercury". Mercury already has Docker 29.5.0 installed and is reachable via passwordless SSH. Build out: a script (or `npm run` target) that builds the image locally, tags it with the `package.json` version, ships it to Mercury (e.g. `docker save | ssh mercury docker load`, or a local registry, or push to a registry mercury can pull from), and brings up the stack on Mercury via `docker compose up -d`. Decide image-transfer mechanism, registry choice (local vs. ghcr.io vs. none), config/secret handling on the target (vault key, API keys, persistent volumes for `workspace/`), and rollback path. Goal: one command from neptune produces a fully-running AuthorClaw on mercury ready for end-to-end testing. **Prerequisite for the Playwright e2e tests item below.**
- [ ] **Playwright end-to-end test suite.** Once the Mercury deploy automation lands, build a Playwright suite that drives the dashboard against the live container on Mercury: dashboard loads, chat flows, project creation through one production phase, file upload/export, persona CRUD, confirmation-gate approval flow. Decide test runner home (`tests/e2e/` in this repo), how Playwright authenticates to the Mercury host (URL via env var), and what counts as a passing baseline before adding more flows. Complements — does not replace — the existing "No test suite exists" item, which targets unit-level coverage of `AIRouter` and `ProjectEngine` rather than browser-level e2e.
- [ ] **Multi-book management with selectable author and genre styles.** Today the gateway assumes a single author identity (`workspace/soul/{SOUL,STYLE-GUIDE,VOICE-PROFILE,PERSONALITY}.md`) and treats `genre` as a free-text field on each project. Projects under `workspace/projects/<id>/` are a flat list with no concept of a "book" that owns state across the planning → bible → production → revision → format → launch phases. Build out:
  - A **book** entity (id, title, current phase, author-style ref, genre-style ref, project history) so multiple books can be in flight simultaneously at different production phases, with a dashboard view that shows each book's current phase and next action.
  - **Author style profiles** — multiple named identity bundles (each its own SOUL/STYLE-GUIDE/VOICE-PROFILE set), selectable per book. Reuse `services/personas.ts` and `services/style-clone.ts` rather than inventing a parallel system; the storage shape should let an author profile be cloned, edited, and assigned without touching the global `workspace/soul/`.
  - **Genre style profiles** — named genre packs (tropes, beats, reader-expectation notes, comp-title pointers) selectable per book, replacing the current free-text `genre` field while keeping backward compatibility with existing projects.
  - Migration path for the existing single-book / single-soul setup: treat the current `workspace/soul/` as a default author profile and existing projects as a default book, so nothing breaks on upgrade.

## Standing constraints (do not "fix" these)

- Server bind defaults to `0.0.0.0` and is overridable via `AUTHORCLAW_BIND`. CORS / Socket.IO / Helmet `connectSrc` are permissive (`*`). This is a deliberate departure from the upstream localhost-only contract so the Docker image is usable on a LAN. **Do not revert to `127.0.0.1`-only.**
- Fail-soft init (services log `⚠`, gateway continues) is intentional — don't make startup require optional deps (better-sqlite3, yt-dlp, Ollama).
- `.js` import extensions on `.ts` source files are required by `NodeNext` module resolution — don't strip them.
- `skills/premium/*/` is intentionally gitignored — never commit premium skill content.
- `ConfirmationGateService` must gate every new feature with external side effects (publish, send, submit, upload, bid, purchase).
