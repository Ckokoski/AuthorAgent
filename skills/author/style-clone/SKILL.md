---
name: style-clone
description: Analyze and match the author's unique writing voice
author: AuthorClaw
version: 1.1.0
triggers:
  - "learn my style"
  - "match my voice"
  - "style check"
  - "voice profile"
  - "analyze my writing"
  - "sound like me"
permissions:
  - file:read
  - file:write
---

# Style Clone Skill

Analyze the author's writing to create a quantitative Voice Profile, then use it
to match their style.

> **Use the gateway's analyzer — do NOT hand-roll a freeform analysis.**
> AuthorClaw already ships a 47-marker voice analyzer as a first-class service
> (`StyleCloneService`). It is deterministic, cheap (no AI call), and returns a
> structured `StyleProfile` plus an AI system prompt you can apply to every
> drafting/revision task. This skill's job is to CALL that service and save the
> result — not to re-describe the analysis in prose. A parallel markdown-only
> pass would drift from the real analyzer and produce a worse, unquantified
> profile.

## How to run it

### On raw text (5,000+ words → more is better)
Call the analyzer endpoint:

```
POST /api/style-clone/analyze
Content-Type: application/json

{ "text": "<the author's writing sample>", "source": "manual-paste" }
```

Response: `{ "profile": <StyleProfile> }` — a 47-marker fingerprint across five
axes (sentence structure, vocabulary, punctuation, syntax, voice) plus a
ready-to-use `systemPrompt` for maintaining voice.

### On a whole project's completed chapters
```
POST /api/projects/:id/style-clone
```
The service gathers the project's completed writing-phase chapters, concatenates
them, and analyzes the combined text. Response is the same `{ "profile": ... }`.

## After analysis — persist the profile
1. Save the returned profile's `systemPrompt` (and key markers) to
   `workspace/soul/VOICE-PROFILE.md` so future `creative_writing` / `revision`
   tasks inherit the voice.
2. Because the analyzer is local and fast, re-run it on new chapters to detect
   **voice drift** — compare the fresh markers against the saved profile.

## Style check (drift detection)
When asked to check new text against the author's style:
1. Analyze the new text via `POST /api/style-clone/analyze`.
2. Diff its markers against the saved `VOICE-PROFILE.md` baseline.
3. Report per axis: ✅ matches, ⚠️ minor drift, ❌ significant departure.
4. Offer specific suggestions (never rewrite without permission).

## The 47 markers (what the service measures)
- **Sentence structure** — length, variance, rhythm, fragment rate,
  sentences/paragraph.
- **Vocabulary** — type-token ratio, rare-word rate, Latinate vs Germanic,
  Flesch reading ease, repetition index.
- **Punctuation** — em-dash / semicolon / colon / ellipsis / comma rates, etc.
- **Syntax** — passive voice, compound/subordinate rates, participial openers,
  nominalization.
- **Voice** — contraction, filter-word, adverb, dialogue density, sensory
  density, hedging, intensifiers, tense mix.

## Commands
- "Learn my style from [text/file]" — run `POST /api/style-clone/analyze` and
  save the profile to `VOICE-PROFILE.md`.
- "Check this against my style" — analyze the new text and diff against the
  saved profile.
- "Show my voice profile" — display the current `VOICE-PROFILE.md`.
