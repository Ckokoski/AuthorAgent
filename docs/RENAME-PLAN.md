# Rename Plan: AuthorClaw → BookClaw

Tracked for later execution. Captures decisions, runbook, and verification steps so this can be picked up cold.

## Status

- **Decision date:** _pending — none of the four decisions below have been confirmed yet._
- **Execution:** _not started._
- **Reversible?** Yes. Git history preserves the old name; `gh repo rename` works both directions; the directory can be moved back. Cost of changing again later is the same as this first rename.

## Why "BookClaw" — alignment with the North Star

The rename is not just cosmetic. The project's **North Star** (TODO.md → "North Star — the ultimate goal") is a **multi-author, multi-book studio**: many books in flight, each with its own author profile, genre, and customizable pipeline. "AuthorClaw" centers a single author; "**BookClaw**" centers the **book** — which is exactly the first-class entity the North Star introduces. So this rename should be treated as a small down-payment on that model, not a pure find-and-replace:

- When updating operator-facing copy (banner, `console.log` posture lines, setup-wizard prompts, README), phrase things in **book / author-profile** terms where it's natural, rather than re-cementing "the author" as a singleton. Don't over-engineer — no new entities are built here — but don't write new copy that the multi-author model will immediately contradict.
- The brand and the eventual data model should agree: a tool called *BookClaw* that can only ever hold one author/one book is a naming mismatch waiting to happen. Keep that in mind for any judgement call the runbook doesn't cover.

## Context

- **Current remote:** `https://github.com/pshort05/authorclaw.git` (already a personal fork, not upstream).
- **Current local path:** `/home/paul/data/dev/authorclaw/`.
- **Scope discovered:** 465 case-insensitive `authorclaw` matches across ~40 tracked files (source + docs + skills + scripts).
- **Env vars that touch real runtime behavior:**
  - `AUTHORCLAW_VAULT_KEY` — decrypts the existing vault at `workspace/.vault/vault.enc`. Reader: `gateway/src/security/vault.ts:55`.
  - `AUTHORCLAW_BIND` — server bind address (default `0.0.0.0`). Reader: `gateway/src/index.ts:2609`.
- **Workspace state safety:** the vault is encrypted with the master-key *value*, not the variable name. As long as the same value flows to whatever variable the code reads, the existing vault keeps decrypting.

## Decisions (with recommendations)

### 1. Remote: rename in place vs. new repo

- **(a) `gh repo rename`** on `pshort05/authorclaw` → `pshort05/bookclaw`. GitHub auto-redirects the old URL, keeps stars / issues / forks. **— RECOMMENDED**
- (b) Create `pshort05/bookclaw` fresh, push the renamed code, archive `pshort05/authorclaw`. Cleaner break but loses redirect.

### 2. Env vars: rename or keep

- (a) Rename hard: `AUTHORCLAW_VAULT_KEY` → `BOOKCLAW_VAULT_KEY`. Every deployed `.env` must be updated or the gateway boots with a fresh empty vault. Simplest code.
- **(b) Dual-read fallback:** code reads `BOOKCLAW_VAULT_KEY || AUTHORCLAW_VAULT_KEY`. No deployment breakage; new name accepted going forward. **— RECOMMENDED**
- (c) Don't rename env vars at all. Brand leaks into operator-facing config forever.

### 3. Local directory: rename or leave

- **(a) Rename** `/home/paul/data/dev/authorclaw/` → `/home/paul/data/dev/bookclaw/`. Disrupts shell history, any running watchers / processes, and any path bookmarked elsewhere. The active Claude Code session must be relaunched in the new directory. **— RECOMMENDED for consistency**
- (b) Leave it. Directory name mismatches project name forever, but zero disruption.

### 4. Internal `AuthorClawGateway` class name in `gateway/src/index.ts`

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
  -e 's/AuthorClaw/BookClaw/g' \
  -e 's/authorclaw/bookclaw/g' \
  -e 's/AUTHORCLAW_/BOOKCLAW_/g'

# 2. Apply env-var dual-read fallback (do this with Edit, not sed):
#    gateway/src/security/vault.ts:55
#       was: let passphrase = process.env.AUTHORCLAW_VAULT_KEY || '';
#       now: let passphrase = process.env.BOOKCLAW_VAULT_KEY
#                          || process.env.AUTHORCLAW_VAULT_KEY
#                          || '';
#    gateway/src/index.ts:2609
#       was: this.server.listen(port, process.env.AUTHORCLAW_BIND || '0.0.0.0', ...)
#       now: this.server.listen(port,
#              process.env.BOOKCLAW_BIND || process.env.AUTHORCLAW_BIND || '0.0.0.0', ...)
#    Update the inline comments on each to mention both names.

# 3. Sanity-check the package metadata
grep '"name"' package.json package-lock.json   # both should now say "bookclaw"

# 4. Commit + push
git add -A
git commit -m "Rename project: AuthorClaw → BookClaw"
git push origin main

# 5. Rename the GitHub repo (auto-redirects pshort05/authorclaw → pshort05/bookclaw)
gh repo rename bookclaw -R pshort05/authorclaw

# 6. Point the local clone at the new remote URL
git remote set-url origin https://github.com/pshort05/bookclaw.git
git remote -v                                  # verify

# 7. Rename the local directory (run from OUTSIDE it)
cd /home/paul/data/dev
mv authorclaw bookclaw
cd bookclaw                                    # resume work here
```

## Verification

After step 7:

- [ ] `git remote -v` shows `pshort05/bookclaw`.
- [ ] `grep -ci authorclaw $(git ls-files)` returns 0 — or only the two deliberate fallback references in `vault.ts` and `index.ts`.
- [ ] `npm start` (or `npx tsx gateway/src/index.ts`) boots without complaining about a missing `BOOKCLAW_VAULT_KEY` — the fallback reads `AUTHORCLAW_VAULT_KEY` from the existing `.env`.
- [ ] Browser at `http://<host>:3847` loads the dashboard normally.
- [ ] Console banner now says `BookClaw`.
- [ ] `docker compose up` still starts cleanly (container name, volume names, env vars all renamed in `docker/docker-compose.yml`).

## Watch-outs

- **Don't rename `workspace/`.** It's runtime data, gitignored, and paths inside it (`workspace/.vault/`, `workspace/memory/`, etc.) are referenced by absolute path in service code. Leave as-is.
- **`package-lock.json`'s `name` field changes.** That's fine — `npm install` would rewrite it anyway.
- **`.env` file is gitignored** and won't be touched by the sed pass. The dual-read fallback (decision 2b) is exactly what makes that safe.
- **The vault key value must not change.** Only the variable name does. If the value in `.env` is regenerated, every stored credential is lost.
- **`scripts/setup-wizard.sh` writes the old env var name.** The sed pass updates it to `BOOKCLAW_VAULT_KEY`. For users running the wizard fresh, that's correct. For existing users, the dual-read fallback covers them.
- **Skills in `skills/_archived/`** contain `authorclaw` references too. They're inert documentation; sed will update them anyway. No special handling needed.

## Open questions for later (not blocking)

- Does `BOOKCLAW_CORS_ORIGINS` (the env var named in `TODO.md`'s "Full security review" item) need the same dual-read treatment? It doesn't exist yet, so no — it can be born under the new name.
- Should there be a deprecation log line when the gateway reads the legacy `AUTHORCLAW_*` env vars, so operators know to migrate? Cheap to add (one `console.warn` per fallback hit at boot) but adds noise. Decide when implementing.
