# Rename Plan: BookClaw → BookClaw

Tracked for later execution. Captures decisions, runbook, and verification steps so this can be picked up cold.

## Status — COMPLETE (2026-05-31)

All four decisions executed: **1a** (rename remote in place), **2a** (hard env-var rename, no dual-read), **3a** (rename local dir), **4a** (rename `AuthorClawGateway` class). Done in stages, validating at each. This file is now historical; the outcome is recorded in `docs/COMPLETED.md`.

- **Stage A — code rename: DONE & pushed.** Bulk-replaced all occurrences across 147 tracked files with three sed rules (`AuthorClaw→BookClaw`, `AUTHORCLAW→BOOKCLAW` — broadened from the runbook's `AUTHORCLAW_` rule to also catch standalone all-caps banners, `authorclaw→bookclaw`). `.env` var renamed `AUTHORCLAW_VAULT_KEY→BOOKCLAW_VAULT_KEY` (value preserved). **No `vault.enc` existed, so 2a's credential-loss risk was moot** — no migration needed. Verified: `tsc --noEmit` clean, smoke test **16/16 pass**, 0 residual references, class is `BookClawGateway`. Committed as `9cf372c` and pushed.
- **Stage C — remote rename (1a): DONE.** `gh repo rename` → `pshort05/bookclaw`; local `origin` set to `https://github.com/pshort05/bookclaw.git`; old URL auto-redirects; `main` synced.
- **Stage D — local directory rename (3a): DONE.** `cd /home/paul/data/dev && mv authorclaw bookclaw`; session relaunched from `/home/paul/data/dev/bookclaw`. Pre-checks had passed (no systemd user units, no processes rooted in the old path).

### Post-`mv` validation (all passed in the relaunched session)

- [x] `pwd` ends in `/bookclaw`; `git remote -v` shows `pshort05/bookclaw`.
- [x] `git grep -li authorclaw` lists **only** `docs/RENAME-PLAN.md` (this file deliberately quotes the old name in the runbook/resume steps); every other file is 0.
- [x] `.env` present with `BOOKCLAW_VAULT_KEY` (value intact).
- [x] `npm run test:smoke` → 18/18 pass; `npx tsc --noEmit` clean.
- [x] RENAME-PLAN item moved from `docs/TODO.md` to `docs/COMPLETED.md` with completion date.

**Reversible?** Yes. Git history preserves the old name; `gh repo rename` works both directions; the directory can be moved back.

## Why "BookClaw" — alignment with the North Star

The rename is not just cosmetic. The project's **North Star** (TODO.md → "North Star — the ultimate goal") is a **multi-author, multi-book studio**: many books in flight, each with its own author profile, genre, and customizable pipeline. "BookClaw" centers a single author; "**BookClaw**" centers the **book** — which is exactly the first-class entity the North Star introduces. So this rename should be treated as a small down-payment on that model, not a pure find-and-replace:

- When updating operator-facing copy (banner, `console.log` posture lines, setup-wizard prompts, README), phrase things in **book / author-profile** terms where it's natural, rather than re-cementing "the author" as a singleton. Don't over-engineer — no new entities are built here — but don't write new copy that the multi-author model will immediately contradict.
- The brand and the eventual data model should agree: a tool called *BookClaw* that can only ever hold one author/one book is a naming mismatch waiting to happen. Keep that in mind for any judgement call the runbook doesn't cover.

## Context

- **Current remote:** `https://github.com/pshort05/bookclaw.git` (already a personal fork, not upstream).
- **Current local path:** `/home/paul/data/dev/bookclaw/`.
- **Scope discovered:** 465 case-insensitive `bookclaw` matches across ~40 tracked files (source + docs + skills + scripts).
- **Env vars that touch real runtime behavior:**
  - `BOOKCLAW_VAULT_KEY` — decrypts the existing vault at `workspace/.vault/vault.enc`. Reader: `gateway/src/security/vault.ts:55`.
  - `BOOKCLAW_BIND` — server bind address (default `0.0.0.0`). Reader: `gateway/src/index.ts:2609`.
- **Workspace state safety:** the vault is encrypted with the master-key *value*, not the variable name. As long as the same value flows to whatever variable the code reads, the existing vault keeps decrypting.

## Decisions (with recommendations)

### 1. Remote: rename in place vs. new repo

- **(a) `gh repo rename`** on `pshort05/bookclaw` → `pshort05/bookclaw`. GitHub auto-redirects the old URL, keeps stars / issues / forks. **— RECOMMENDED**
- (b) Create `pshort05/bookclaw` fresh, push the renamed code, archive `pshort05/bookclaw`. Cleaner break but loses redirect.

### 2. Env vars: rename or keep

- (a) Rename hard: `BOOKCLAW_VAULT_KEY` → `BOOKCLAW_VAULT_KEY`. Every deployed `.env` must be updated or the gateway boots with a fresh empty vault. Simplest code.
- **(b) Dual-read fallback:** code reads `BOOKCLAW_VAULT_KEY || BOOKCLAW_VAULT_KEY`. No deployment breakage; new name accepted going forward. **— RECOMMENDED**
- (c) Don't rename env vars at all. Brand leaks into operator-facing config forever.

### 3. Local directory: rename or leave

- **(a) Rename** `/home/paul/data/dev/bookclaw/` → `/home/paul/data/dev/bookclaw/`. Disrupts shell history, any running watchers / processes, and any path bookmarked elsewhere. The active Claude Code session must be relaunched in the new directory. **— RECOMMENDED for consistency**
- (b) Leave it. Directory name mismatches project name forever, but zero disruption.

### 4. Internal `BookClawGateway` class name in `gateway/src/index.ts`

- **(a) Rename** to `BookClawGateway`. Touches one file. **— RECOMMENDED**
- (b) Leave it. Internal-only; doesn't affect users.

## Runbook (assuming recommended choices: 1a, 2b, 3a, 4a)

Run from the project root with a clean working tree on `main`.

```bash
# 0. Prereqs
git status                                    # must be clean
command -v gh && gh auth status               # gh CLI installed and authed

# 1. Bulk text replace across all tracked files
git ls-files -z | xargs -0 sed -i \
  -e 's/BookClaw/BookClaw/g' \
  -e 's/bookclaw/bookclaw/g' \
  -e 's/BOOKCLAW_/BOOKCLAW_/g'

# 2. Apply env-var dual-read fallback (do this with Edit, not sed):
#    gateway/src/security/vault.ts:55
#       was: let passphrase = process.env.BOOKCLAW_VAULT_KEY || '';
#       now: let passphrase = process.env.BOOKCLAW_VAULT_KEY
#                          || process.env.BOOKCLAW_VAULT_KEY
#                          || '';
#    gateway/src/index.ts:2609
#       was: this.server.listen(port, process.env.BOOKCLAW_BIND || '0.0.0.0', ...)
#       now: this.server.listen(port,
#              process.env.BOOKCLAW_BIND || process.env.BOOKCLAW_BIND || '0.0.0.0', ...)
#    Update the inline comments on each to mention both names.

# 3. Sanity-check the package metadata
grep '"name"' package.json package-lock.json   # both should now say "bookclaw"

# 4. Commit + push
git add -A
git commit -m "Rename project: BookClaw → BookClaw"
git push origin main

# 5. Rename the GitHub repo (auto-redirects pshort05/bookclaw → pshort05/bookclaw)
gh repo rename bookclaw -R pshort05/bookclaw

# 6. Point the local clone at the new remote URL
git remote set-url origin https://github.com/pshort05/bookclaw.git
git remote -v                                  # verify

# 7. Rename the local directory (run from OUTSIDE it)
cd /home/paul/data/dev
mv bookclaw bookclaw
cd bookclaw                                    # resume work here
```

## Verification

After step 7:

- [ ] `git remote -v` shows `pshort05/bookclaw`.
- [ ] `grep -ci bookclaw $(git ls-files)` returns 0 — or only the two deliberate fallback references in `vault.ts` and `index.ts`.
- [ ] `npm start` (or `npx tsx gateway/src/index.ts`) boots without complaining about a missing `BOOKCLAW_VAULT_KEY` — the fallback reads `BOOKCLAW_VAULT_KEY` from the existing `.env`.
- [ ] Browser at `http://<host>:3847` loads the dashboard normally.
- [ ] Console banner now says `BookClaw`.
- [ ] `docker compose up` still starts cleanly (container name, volume names, env vars all renamed in `docker/docker-compose.yml`).

## Watch-outs

- **Don't rename `workspace/`.** It's runtime data, gitignored, and paths inside it (`workspace/.vault/`, `workspace/memory/`, etc.) are referenced by absolute path in service code. Leave as-is.
- **`package-lock.json`'s `name` field changes.** That's fine — `npm install` would rewrite it anyway.
- **`.env` file is gitignored** and won't be touched by the sed pass. The dual-read fallback (decision 2b) is exactly what makes that safe.
- **The vault key value must not change.** Only the variable name does. If the value in `.env` is regenerated, every stored credential is lost.
- **`scripts/setup-wizard.sh` writes the old env var name.** The sed pass updates it to `BOOKCLAW_VAULT_KEY`. For users running the wizard fresh, that's correct. For existing users, the dual-read fallback covers them.
- **Skills in `skills/_archived/`** contain `bookclaw` references too. They're inert documentation; sed will update them anyway. No special handling needed.

## Open questions for later (not blocking)

- Does `BOOKCLAW_CORS_ORIGINS` (the env var named in `TODO.md`'s "Full security review" item) need the same dual-read treatment? It doesn't exist yet, so no — it can be born under the new name.
- Should there be a deprecation log line when the gateway reads the legacy `BOOKCLAW_*` env vars, so operators know to migrate? Cheap to add (one `console.warn` per fallback hit at boot) but adds noise. Decide when implementing.
