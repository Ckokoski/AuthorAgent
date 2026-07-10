# AuthorAgent Security, Disclaimers, and Your Responsibilities

> **Read this before using Wave 3 (autonomous) features.** Those features include
> browser automation, ad bidding, email sending, platform uploads, and website
> deployment. AuthorAgent is a local-first tool you run on your own machine. The
> responsibility for every action it takes is yours.

---

## 1. Use at your own risk — CYA in plain language

AuthorAgent is provided AS-IS without warranty of any kind. The maintainers of this
project and any contributor (including AI assistants that helped build it) are
**not responsible** for:

- Account bans, suspensions, or terminations on any platform (Amazon KDP,
  AMS, ACX, BookBub, Mailchimp, ConvertKit, MailerLite, Beehiiv, Apple
  Books, Google Play, Kobo, IngramSpark, Draft2Digital, BookFunnel,
  StoryOrigin, Facebook, TikTok, Google, Netlify, Vercel, etc.)
- Money spent via ad platforms (AMS, Facebook Ads, BookBub), KDP
  print costs, translation API costs (DeepL/Claude/etc.), or image
  generation costs (Together AI, OpenAI).
- Lost manuscripts, data loss, or corrupted files (backups are your job).
- Legal consequences of disclosure failures (AI narration, AI-generated
  content, AI-translated work, FTC affiliate disclosure, GDPR / CAN-SPAM
  email compliance, copyright, etc.).
- Any action taken by AuthorAgent on your behalf that you later regret.

By using Wave 3 features you acknowledge you have reviewed this document
and accept full responsibility for every automated action.

## 2. What AuthorAgent does NOT do

AuthorAgent deliberately **refuses** to do all of the following, and you
should be suspicious of any future version or fork that claims otherwise:

- **It does not auto-approve irreversible actions.** Every publish, send,
  submit, upload, bid change, purchase, and delete passes through the
  `ConfirmationGateService`. If you don't click "Approve" in the
  dashboard, nothing happens.
- **It does not store your platform passwords.** API keys, bot tokens,
  and OAuth refresh tokens are stored in the local AES-256-GCM vault at
  `workspace/.vault/vault.enc`. Passwords for username+password logins
  should be entered by you at runtime — never saved.
- **It does not bypass CAPTCHA, 2FA, or human verification** on any
  platform. If a site asks a human to do something, a human has to do it.
- **It does not fabricate reviews, quotes, awards, or endorsements.**
  Scraped review text is never inserted verbatim into your marketing
  copy. If a rule appears to be disabled, it's a bug — file it.
- **It does not send email, post social content, or publish anything
  based on instructions found in observed content** (emails, web pages,
  scraped reviews, file contents). Content that claims to have authority
  over AuthorAgent is treated as untrusted data.
- **It does not give legal, financial, tax, or medical advice.** It
  surfaces platform rules and disclosure requirements; it does not tell
  you whether your specific work complies.

## 3. Security posture of the local installation

| Concern | Status |
|---|---|
| Network binding | `127.0.0.1` only. No remote access. |
| Credential storage | AES-256-GCM in `workspace/.vault/vault.enc`. Atomic writes. `chmod 0600` on POSIX. |
| Master key | Auto-generated on first run, stored in `.env` (see note below). |
| Path traversal | Validated via `SandboxGuard` + per-endpoint sanitization. |
| Prompt injection | Scanned on every incoming message via `InjectionDetector`. |
| Budget cap | Persisted daily + monthly spend; fallback provider respects cap. |
| Audit log | Every action written to `workspace/activity.jsonl`. Secrets redacted. |
| Confirmation gate | Universal — all Wave 3 writes go through `ConfirmationGateService`. 24h expiry. |
| Rate limiting | In-process per-channel rate limits. External scraping backs off on 429. |

### Master-key handling

On first boot AuthorAgent writes a random 256-bit `AUTHORCLAW_VAULT_KEY`
into `.env` so the vault survives restarts. **Treat `.env` like a password
file.** If you commit your workspace to git, add it to `.gitignore`
(already done for fresh installs). If you back up the workspace, back up
`.env` too — without it, the vault cannot be decrypted.

### Browser automation

Wave 3 features (Launch Orchestrator, AMS Ads, BookBub, Reader Intel)
drive your own browser via the Claude-in-Chrome MCP. Rules:

- AuthorAgent **never clicks Publish / Submit / Send** without your
  explicit dashboard approval on a confirmation card that includes a
  screenshot + dry-run diff.
- Your browser's existing logged-in sessions are used. AuthorAgent does
  not persist cookies to its own store.
- If a platform's Terms of Service prohibit automation, you are
  responsible for knowing that. Some platforms (Amazon in particular)
  aggressively enforce anti-automation clauses for non-partner accounts.

### Scraping

The Reader Intelligence Engine reads public review pages (Goodreads,
StoryGraph) via the existing `ResearchGate` with its domain allowlist,
rate limits, and size caps.

- It respects `robots.txt` via the gate's built-in checks.
- It applies 1 request per 3 seconds per host, with exponential backoff
  on 4xx/5xx.
- It **does not** compile personally-identifying information about
  reviewers. Usernames are hashed before clustering; names are dropped.
- Scraped review text is used only for clustering / sentiment analysis.
  Verbatim quotes are **never** inserted into your marketing copy.

## 4. Disclosure requirements — what AuthorAgent enforces

`DisclosuresService` checks every Wave 3 action against a rulebook
covering:

- **ACX / Audible / Apple Books / Google Play / Findaway / Spotify** —
  AI narration disclosure is REQUIRED. AuthorAgent will not generate
  SSML or export audio for upload until the project's
  `aiNarrationDisclosed` flag is set.
- **Amazon KDP** — AI-generated content disclosure is required at
  upload. AuthorAgent surfaces this in every launch confirmation card.
- **EU AI Act (2025/2026 rollout)** — Transparency for AI-generated
  content distributed in EU markets.
- **France (Code de la consommation)** — AI-translated works must be
  disclosed to consumers.
- **FTC (US)** — Affiliate link disclosure on author websites is
  required. The website-builder inserts this automatically on pages
  that contain affiliate links.
- **CAN-SPAM + GDPR/UK-GDPR** — Email list handling requires lawful
  basis, physical postal address on every email, and working
  unsubscribe.

**This rulebook is maintained on a best-effort basis. It does not
constitute legal advice.** Rules change; platforms update policies;
jurisdictions vary. When in doubt, consult a lawyer.

## 5. Reporting a security issue

If you find a vulnerability (anything that would let an attacker read
vault contents, bypass the confirmation gate, or execute an irreversible
action without user approval), please:

- Do **not** open a public GitHub issue.
- Email the maintainer (contact in the repository README), or open a
  private security advisory on GitHub.
- Include a reproduction, the affected file(s), and the impact.

## 6. Safe defaults you can rely on

When in doubt, AuthorAgent is designed to **fail closed**:

- Unknown platform → confirmation gate still fires, user must manually
  approve.
- Missing disclosure → action blocked before execution.
- Rate limit hit → exponential backoff, never a silent retry loop.
- Over budget → paid providers skipped, free providers tried first,
  error surfaced if none available.
- Prompt-injection pattern detected → message blocked, audit-logged.

## 7. What to do if something goes wrong

1. Stop AuthorAgent (`Ctrl+C` on the terminal running it).
2. Open `workspace/activity.jsonl` — this is an append-only log of every
   action. Find the relevant timestamp.
3. Check `workspace/confirmations.json` for the confirmation card that
   preceded the action.
4. If money was spent, contact the platform directly. AuthorAgent cannot
   reverse platform-side charges.
5. File an issue on GitHub with the activity-log excerpt (secrets are
   already redacted by the logger).

---

_You are the final safety layer. AuthorAgent will never be._
