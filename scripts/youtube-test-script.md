# AuthorAgent v2.0.0 — YouTube Demo Testing Script

Fast-paced testing sequence. Each test should take 30-60 seconds.
Total demo time: ~15-20 minutes.

---

## PRE-FLIGHT (Before Recording)

1. **VM running** — SSH into VM: `ssh user@localhost -p 2222`
2. **Copy latest code**: `.\scripts\copy-to-vm.ps1` (on Windows)
3. **Deploy on VM**: `bash /media/sf_authorclaw-transfer/run.sh`
4. **Verify health**: `curl http://localhost:3847/api/health` → `{"status":"ok"}`
5. **Telegram bot** — Ensure token + allowed users configured in dashboard Settings
6. **API key** — Ensure Gemini or other AI key is stored in vault

---

## TEST SEQUENCE (On Camera)

### 1. Dashboard Overview (1 min)
- Open `http://localhost:3847` in Firefox
- Show the welcome banner
- Click through tabs: Chat, Goals, Skills, Settings, Live Progress
- Point out the Writing Secrets branding

### 2. Chat Test (1 min)
- Type: `Hello, who are you?`
- Show the AI responds with AuthorAgent personality
- Type: `What skills do you have?`
- Show skill list

### 3. Telegram — Basic Commands (2 min)
- Open Telegram on phone
- Send: `/help` → Show command list
- Send: `Hi, what can you do?` → Should be SHORT response (not a chapter dump!)
- Send: `/status` → Shows "Nothing running" or current status

### 4. Goal Engine — Create & Run (2 min)
**On Telegram:**
- Send: `/goal write a 500-word flash fiction about a robot discovering music`
- Watch it plan steps and auto-execute
- Show progress messages arriving
- When done, send: `/goals` → See completed goal

**On Dashboard:**
- Switch to Goals tab → See the goal listed
- Click to see details

### 5. Files & Reading (1 min)
**On Telegram:**
- Send: `/files` → See numbered file list
- Send: `/read 1` → Read the first file by number
- Show the content preview

### 6. Research (1 min)
**On Telegram:**
- Send: `/research best self-publishing platforms 2026`
- Wait for results
- Show research saved to file

### 7. TTS / Read Aloud — Premium Feature (2 min)
**On Telegram:**
- Send: `/speak The detective stepped into the dimly lit library, her footsteps echoing on the marble floor.`
- Should get a voice message back (if Piper installed)
- Play the voice message

**If Piper not installed:**
- Show the helpful error message: "TTS not available — install Piper TTS"
- Explain this is a premium feature from the Writing Secrets skill pack

### 8. Export (1 min)
**On Telegram:**
- Send: `/files` → Pick a file
- Send: `/export 1 docx` → Export to Word
- Show result message

**If Format Factory not available:**
- Show the helpful error message
- Explain Author OS integration

### 9. Conductor — Launch Full Novel (3 min)
**On Telegram:**
- Send: `/conductor`
- Show launch confirmation
- Wait for first phase notification: `🎼 Phase 1: ...`
- Wait for first chapter notification: `📖 Chapter 1/25 done`
- Send: `/status` → Show conductor progress with phase, chapters, words, time

**On Dashboard:**
- Switch to Live Progress tab → Show real-time conductor output
- Show word count climbing

### 10. Stop & Control (1 min)
**On Telegram:**
- Send: `/stop conductor` → Stop the conductor
- Show confirmation
- Send: `/status` → Confirm stopped

### 11. Multiple AI Models (1 min)
**On Dashboard:**
- Go to Settings tab
- Show AI model selector: Ollama, Gemini, DeepSeek, Claude, OpenAI
- Switch model if multiple configured
- Send a test message to show it uses the new model

### 12. Security Demo (1 min)
**On Dashboard:**
- Go to Settings → Show vault (encrypted API keys)
- Mention: AES-256 encryption, sandbox, audit log, injection detection
- Show Telegram user ID masking

---

## QUICK TELEGRAM COMMAND CHEAT SHEET

```
/help                    — Show all commands
/goal [task]             — Create & auto-run any task
/write [idea]            — Plan & write a book
/goals                   — List all goals
/conductor               — Launch full book conductor
/status                  — Check everything
/research [topic]        — Research a topic
/files                   — List files (numbered)
/read [# or name]        — Read a file
/export [# or name]      — Export to Word/EPUB/PDF
/speak [text]            — Text-to-speech voice message
/stop                    — Stop everything
/stop goal               — Stop goal only
/stop conductor          — Stop conductor only
continue                 — Resume paused goal
```

---

## TALKING POINTS

- **Free & open source** — MIT licensed, runs locally
- **Your data stays yours** — No cloud, no tracking, no subscriptions
- **25-chapter novels** — 80,000+ words, fully autonomous
- **Multiple AI models** — Use free (Ollama, Gemini) or paid (Claude, OpenAI)
- **Telegram command center** — Control everything from your phone
- **Author OS integration** — Workflow Engine, Book Bible, Format Factory
- **Premium skills** — Read Aloud, Writing Secrets (Ko-Fi)
- **Security-first** — Vault encryption, sandboxing, audit logging

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| No Telegram messages | Check bot token + allowed users in Settings |
| AI not responding | Check API key in vault (Settings tab) |
| Conductor won't start | Check `/api/conductor/running` — may already be running |
| TTS not working | Install Piper: `pip3 install piper-tts` |
| Export not working | Install Author OS tools on VM |
| Goals not showing | Refresh dashboard, check Goals tab |
