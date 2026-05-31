# Mattermost Agent Chat — Design & Plan

**Date:** 2026-05-31
**Status:** Design approved, not yet implemented (no code/infra changed yet)
**Goal:** A self-hosted, Telegram-like chat **UI on neptune** where a human can watch and join the **AuthorClaw ⇄ OpenClaw** conversation.

---

## Decisions made (don't re-litigate)

These were settled during brainstorming. Don't reopen unless requirements change.

| Decision | Choice | Why |
|---|---|---|
| **Platform** | **Mattermost (Team Edition)** | Lightest full-featured self-hosted chat: single Go container + Postgres. Best bot API for "two agents posting into a room I sit in." Real iOS/Android/desktop/web apps. Lowest ops burden on an already-busy host. |
| **Hosting model** | **Self-hosted on neptune** | Hard requirement. Rules out cloud (Telegram, Discord) — the chat backend must run locally, not in a third party's datacenter. |
| **Agent wiring** | **Light glue per agent** | OK to add a small per-agent adapter. We do NOT reuse the Telegram bridges as-is. |
| **Comm pattern** | **Start simple, design for both** | Build *each-agent-reports-to-you* now; structure adapters so *agent-to-agent* is a later config flag + loop-guard, not a rewrite. |
| **Access scope** | **LAN-only (default), port 8065** | Matches the trusted-LAN posture in `TELEGRAM-SETUP.md`. Remote/phone-away access deferred (reverse proxy or existing VPN) — not built now. |

### Rejected options
- **Real Telegram / Discord (cloud):** rejected — traffic must stay on neptune.
- **Rocket.Chat:** heavier (MongoDB), more aggressive/breaking updates, no capability win here.
- **Revolt / Spacebar (self-hosted Discord):** more moving parts (multi-container), younger, mobile apps less polished.
- **Matrix/Synapse + Element:** most powerful + future-proof (federation, E2EE, Telegram bridge), but heaviest ops burden. Overkill for two bots + one human. Revisit only if federation/E2EE/bridging becomes a requirement.

---

## Why this isn't "self-hosted Telegram"

There is **no fully self-hostable Telegram server** — Telegram's server software is proprietary. The only self-hostable piece is the open-source Bot API server (`tdlib/telegram-bot-api`), which still relays through Telegram's datacenters. Since the hard requirement is "nothing leaves neptune," Telegram (and Discord) are out, and a self-hosted chat platform (Mattermost) is the right substitute for the *function* the user wanted: a human chat UI watching two agents.

---

## Key architectural asymmetry (drives the two adapters)

The two agents are NOT equally easy to extend:

- **AuthorClaw** runs **from source** (`/home/paul/data/dev/authorclaw`, launched via `tsx`). It has a clean bridge seam and a `discord.ts` stub showing exactly where a new bridge slots in. **Adding a Mattermost bridge here is genuinely light.**
- **OpenClaw** runs as a **packaged npm app from compiled `dist/`** inside a container (`@openclaw/openclaw`, gateway on 18789–18790). Its channels use a plugin-SDK "channel contract," but it is **not our source to freely edit**. So OpenClaw glue needs a **spike** to choose between a loadable extension vs. a sidecar bridge.

---

## Integration seams (from code exploration)

### AuthorClaw (Node 22 / TypeScript, `tsx`, port 3847)

- **Bridge dir:** `gateway/src/bridges/` — `telegram.ts` (working reference), `discord.ts` (empty stub).
- **Inbound seam:** the gateway registers a handler at `index.ts:991–992`:
  ```ts
  this.telegram.onMessage((content, channel, respond) =>
    this.handleMessage(content, channel, respond)
  );
  ```
  A bridge implements `onMessage(handler: (content, channel, respond) => Promise<void>)` and calls `handler(content, channel, respond)` when a message arrives.
- **Outbound seam:** the `respond: (text: string) => void` callback. Telegram's impl POSTs to its API inside that callback (`telegram.ts:622–672`). For Mattermost, `respond` POSTs to `/api/v4/posts`.
- **Channel keying:** plain string (e.g. `mattermost:<channel-id>`); used to keep per-channel conversation history. No hardcoded channel-type routing.
- **Wiring point:** `index.ts` Phase 8 (Bridges) — instantiate, `.onMessage(...)`, `.connect()`, next to Telegram.
- **Config:** `config/default.json` → `bridges.mattermost: { enabled, serverUrl, team, channels, allowedUsers }`.
- **Secrets:** encrypted vault (`config/.vault/vault.enc`), key `mattermost_bot_token`, via `this.vault.get('mattermost_bot_token')`.

### OpenClaw (Node 22 / TypeScript compiled to `dist/`, gateway 18789–18790)

- **Plugin architecture:** `extensions/telegram/src/` — ingress resolver (`ingress.ts`), outbound (`send.ts` → `sendMessageTelegram`), message adapter glue (`channel.ts` via `createTelegramOutboundAdapter` / `createChannelMessageAdapterFromOutbound`).
- **Channel contract (SDK):** ingress resolver + outbound adapter + message adapter, registered via `createChatChannelPlugin()`.
- **Secrets:** env-based (`TELEGRAM_BOT_TOKEN`), resolved by `resolveTelegramToken()`; config in `openclaw.json` (`channels.*`). No runtime vault in production — tokens are env vars / mounted files.
- **Constraint:** source is shipped inside the container as compiled `dist/`. Editing it in-place is not as clean as AuthorClaw. Hence the spike.

---

## Design

### Section 1 — Infrastructure (the Mattermost instance)

- **Stack:** `mattermost/mattermost-team-edition` container + dedicated `postgres` container via `docker-compose.yml`, following existing appdata conventions (data under `/opt/appdata/mattermost/...` — **verify exact path against disk before writing**).
- **Footprint:** idle ~200–300 MB RAM + light Postgres. No GPU, negligible CPU.
- **Network:** LAN-only, bind neptune LAN IP : **8065**. No public exposure. UFW rule scoped to the LAN subnet only (mirror `TELEGRAM-SETUP.md` firewall guidance).
- **Inside Mattermost:** one team `agents`; channels `#authorclaw`, `#openclaw`, `#agent-chatter`, `#alerts`; two bot accounts `authorclaw-bot`, `openclaw-bot`, each with a personal access token.
- **Usable immediately** after this step — you can chat in it before any agent is wired.

### Section 2 — AuthorClaw adapter (low risk)

- New `gateway/src/bridges/mattermost.ts`, mirroring `telegram.ts`:
  - **Inbound:** Mattermost **WebSocket** (`/api/v4/websocket`) for real-time events (no polling). On a `posted` event in a watched channel, call the registered `messageHandler(content, "mattermost:<channel-id>", respond)`.
  - **Outbound:** `respond(text)` → `POST /api/v4/posts` as `authorclaw-bot` (chunk long messages; Markdown supported natively).
  - **Auth/identity:** ignore posts authored by bot accounts by default (foundation for the agent-to-agent flag).
- **Config:** `bridges.mattermost` in `config/default.json`. **Token** in vault as `mattermost_bot_token`.
- **Wiring:** `index.ts` Phase 8, next to Telegram.
- **Verify:** message in `#authorclaw` → bot replies; round-trip confirmed.

### Section 3 — OpenClaw adapter (spike first)

- **Spike (first task):** determine the viable path without forking the npm package:
  - **(a) Loadable extension** — can the container pick up a mounted `extensions/mattermost/` from a volume? If yes, mirror the Telegram extension's ingress-resolver + outbound-adapter + message-adapter contract.
  - **(b) Sidecar bridge** — a tiny standalone Node container that bridges Mattermost (WebSocket + REST) ↔ OpenClaw's gateway API (18789–18790). Used if the extension path isn't loadable.
- **Commit to (a) or (b) after the spike**, not before.
- **Secrets:** env `MATTERMOST_BOT_TOKEN` (+ `MATTERMOST_SERVER_URL`), per OpenClaw's existing env pattern.
- **Verify:** message in `#openclaw` → bot replies; round-trip confirmed.

### Section 4 — Agent-to-agent (designed, off by default)

- Both adapters **ignore messages from other bot accounts** by default (each-agent-to-you).
- Structure in a config flag (e.g. `agentToAgent: false`) + a **loop-guard** (max-turns / cooldown / stop-word) so enabling cross-bot replies later is a flag flip, not a rewrite. Do not enable now.

---

## Build order (interruption-resilient)

1. **Mattermost + Postgres** up; team/channels/bots created; LAN access verified. *(Usable immediately.)*
2. **AuthorClaw bridge** → verify round-trip in `#authorclaw`.
3. **OpenClaw spike** → implement chosen path → verify round-trip in `#openclaw`.
4. **Agent-to-agent** flag + loop-guard scaffolded, left **off**.

Each step is independently verifiable and leaves the system in a working state.

---

## Open questions / to confirm during implementation

1. **Appdata path:** confirm `/opt/appdata/mattermost/...` matches the host's actual appdata convention (check existing containers' bind mounts).
2. **Compose location:** where the `docker-compose.yml` should live (alongside the other migrated stacks vs. a new dir) — verify against disk.
3. **OpenClaw extensibility:** resolved by the Section 3 spike (extension vs. sidecar).
4. **Remote access:** deferred. If wanted later: reverse proxy (TLS) or ride existing VPN — do not expose 8065 publicly raw.

---

## Resume / handoff notes

- This file is the **design source of truth**. When implementation starts, create a fast-changing **status file** (`/home/paul/mattermost-agent-chat-status.md`) with a phase table + exact next commands, and add a **memory pointer** in `~/.claude/projects/-home-paul/memory/MEMORY.md` linking to it (per the interruption-resilience protocol in `~/.claude/CLAUDE.md`).
- **Next step after this doc:** turn this design into a step-by-step implementation plan (writing-plans), then execute Build order step 1.
