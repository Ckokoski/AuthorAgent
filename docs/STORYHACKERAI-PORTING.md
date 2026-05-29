# StoryHackerAI → AuthorClaw Feature-Porting Candidates

Snapshot taken 2026-05-28. Compares **StoryHackerAI** (`~/data/Writing/StoryHackerAI/`) against the current AuthorClaw tree.

StoryHackerAI is a local-filesystem port of the Story Hacker "Book Builder" n8n workflow set — 6 workflow JSONs (1 orchestrator + 5 stage workflows, ~4,600 lines total) running entirely on **OpenRouter** as the LLM gateway. It's a different product than AuthorClaw architecturally (n8n vs. custom Node daemon), but it solves the same author problem with a meaningfully different decomposition. Several patterns from it would materially improve AuthorClaw, and one of them — making **OpenRouter** the canonical AI gateway — was specifically called out as a priority.

Ranking criterion: marginal value for AuthorClaw's novelist workflow — not workflow-for-workflow parity. Patterns that change the structure of a chapter or the structure of model routing rank above patterns that change file layout.

---

## 🟥 TIER 1 — Architectural shifts with the largest payoff

### 1. OpenRouter as the canonical AI gateway (replaces per-provider wiring)
**StoryHackerAI today:** Every LLM node is `lmChatOpenRouter` with a single shared OpenRouter credential. The 11 models referenced across the 6 workflows span three providers — Anthropic (Claude Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6), Google (Gemini 3 Flash, Pro, 3.1 Flash Lite, 3.1 Pro), and Moonshot (Kimi K2.5, Kimi K2 Thinking) — and switching models is a string change in one config field.

**AuthorClaw today:** Five providers (Gemini, Claude, OpenAI, DeepSeek, Ollama) hard-wired in `AIRouter` (`gateway/src/ai/router.ts`, 737 lines). A recent commit (`212feef "Fix outline truncation, add retry/restart, wire OpenRouter"`) added OpenRouter as **one provider among five**, not as the gateway. Each provider has its own auth path, its own retry semantics, its own cost model.

**Author payoff:**
- **Instant access to ~200 models** through one credential. Adding Kimi, Mistral, Llama variants, Qwen, Cohere, AWS Bedrock, etc. becomes "use this model ID" — no new code.
- **Unified billing.** One OpenRouter invoice instead of five separate provider accounts. Cost tracking simplifies dramatically.
- **Built-in fallbacks.** OpenRouter handles provider outages and rate-limits transparently — if Anthropic is throttling, requests fall through to the next provider for the same model.
- **Specialized models AuthorClaw can't reach today.** Kimi K2 Thinking, niche fine-tunes, smaller European providers, all reachable as soon as OpenRouter lists them.
- **Cheap exploration.** Trying a new model takes seconds (edit a config field), not hours of integration work.

**Effort:** Medium. The change is *not* "delete the other providers." It's:
1. Make OpenRouter the *primary* router path in `AIRouter`.
2. Keep direct Anthropic / OpenAI / DeepSeek / Gemini paths as **optional overrides** for users who already have direct keys and want native billing (a few authors will).
3. Keep Ollama as the local-only path (it's not on OpenRouter).
4. Tiered routing (`cheap` / `mid` / `premium`) becomes a *model-ID map* against OpenRouter slugs, not a provider selector. E.g., `cheap: "google/gemini-3.1-flash-lite-preview"`, `mid: "anthropic/claude-sonnet-4.6"`, `premium: "anthropic/claude-opus-4.6"`.

**Why it's #1:** This is the single change that compounds with almost every other item in the OpenClaw and StoryHackerAI roadmaps. Every Tier-2 item below assumes a working multi-model story; OpenRouter makes that story trivial.

**Cross-references:**
- [OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md) item #19 — OpenClaw's recent provider expansions (DeepInfra catalog, Pixverse video, bare Anthropic IDs, Claude CLI OAuth) become unnecessary work once OpenRouter is the gateway.
- [GOD-CLASS-REFACTOR.md](GOD-CLASS-REFACTOR.md) Level 3 — provider plugin-ifying becomes far simpler when there's only one real provider plus a few overrides.

---

### 2. The Selector → Brief → Draft → Check chapter-generation pattern
**StoryHackerAI today (Stage 5, the chapter pipeline):** Every chapter is generated through **13+ distinct LLM calls** with explicit role separation. For each chapter the pipeline runs:

1. **Plot Selector** (cheap model — which outline beats apply to this chapter)
2. **Character Selector** (cheap — which characters appear)
3. **Worldbuilding Selector** (cheap — which world elements matter)
4. **Plot Scene Brief** (medium — short plot brief)
5. **Character Scene Brief** (medium — short character brief)
6. **Worldbuilding Scene Brief** (medium — short world brief)
7. **Wordcount Estimator** (cheap — predicts chapter length before drafting)
8. **Scene Brief Rewrite** (medium — combines & refines briefs)
9. **Chronology Check** (medium — does this chapter respect the timeline?)
10. **First Draft** (advanced model — writes the chapter)
11. **Style Check** (medium — verifies prose matches `prose_style.md`)
12. **Chronology Check 2** (medium — second pass after draft)
13. **Rewrite** (advanced — final pass incorporating check feedback)

**AuthorClaw today:** `cross_outline.md` references "write + self-review per chapter" in Phase 3 — two steps, one writer + one critic. The Writing Judge service (`craft-critic.ts`, `dialogue-auditor.ts`, `writing-judge` in skills/) is closest in spirit but operates on whole drafts, not chapter-internal sub-passes.

**Author payoff:**
- **Materially better chapters.** The Selectors stop the drafter from hallucinating characters/locations/beats the outline didn't actually plan for it. The Briefs stop the drafter from being overwhelmed by the entire bible. The Checks catch timeline + style violations *before* the chapter lands on disk.
- **Cost-controlled.** Most of the 13 steps run on cheap models. Only the First Draft and the final Rewrite use advanced models. Net cost per chapter is comparable to today's "one heavyweight write + one heavyweight review."
- **Diagnosable.** When a chapter is off, you can see *which sub-pass* misfired (the Character Selector picked the wrong POV, the Chronology Check failed, etc.) instead of staring at a generic bad draft.

**Effort:** High. This is a real architectural change to `services/projects.ts` and the production phase. Not a refactor of one file — it's a redesign of one phase's step graph. Suggest implementing it as an *opt-in* mode (`pipeline mode: standard | deep`) so existing users aren't disrupted.

**Why it's #2:** Continuity and voice consistency are the #1 reader complaint about AI-assisted novels (also called out in [FIRST-NOVEL-GUIDE.md](FIRST-NOVEL-GUIDE.md)'s troubleshooting matrix). Multi-pass-per-chapter is the most effective known mitigation.

---

### 3. Genre templates as first-class reusable artifacts
**StoryHackerAI today:** Each genre lives in `templates/<genre-slug>/` with exactly six markdown files:

| File | Contents |
|---|---|
| `trope.md` | Trope list for the genre (seeds brainstorm + checks fit across stages 1, 2, 3, 4) |
| `theme.md` | Theme list (thematic cohesion across stages 1–4) |
| `plot.md` | Plot/outline template — genre-specific beats and structure (stages 1, 4) |
| `character.md` | Character archetype template for the genre (stages 1, 2) |
| `worldbuilding.md` | Worldbuilding category template (stages 1, 3) |
| `prose_style.md` | Prose-style reference — voice, pacing, sample paragraphs (stage 5) |

The same six files apply to every novel of that genre. You write the romance templates once and run any number of romance novels through them.

**AuthorClaw today:** Genre intelligence is split between (a) the author persona (`workspace/.config/personas.json`), (b) the `story-structures` service (smart-recommends a structure per project), and (c) the implicit knowledge in 19 skills. There's no standalone, swappable, genre-level reference layer that survives across books.

**Author payoff:**
- **Multi-genre authors get cleaner separation.** Today, a persona = a voice. If KS Rhysdale writes both contemporary romance and romantasy, the persona has to span both. With genre templates, the persona stays voice-anchored and the genre layer carries the structural intelligence.
- **Genre templates are shareable.** A romance writer can publish their `romance/prose_style.md` for other writers to use. Aligns with the ClawHub registry pattern in [OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md) item #12.
- **Easier to evolve.** Improving the way AuthorClaw handles romance = editing six files in `templates/romance/`, not retraining a persona or editing skill internals.

**Effort:** Medium. Add a `workspace/templates/<genre-slug>/` convention, teach the project planner to load the six files into context for any project whose persona declares that genre, ship one starter genre (e.g., `templates/romance/`) populated from the existing skill knowledge. Backward-compatible: projects without a genre template fall back to today's behavior.

**Why it's #3:** It's a *clean separation of concerns* that AuthorClaw is going to need anyway as it grows — and it costs much less to introduce now than after a hundred personas have been authored under the current model.

---

## 🟧 TIER 2 — High-value pattern ports

### 4. Explicit Chronology Check as a per-chapter pass
**StoryHackerAI today:** Runs a dedicated **Chronology Check** twice per chapter (once before drafting, once after). Catches timeline violations like "Riley was in Miami last chapter and Manhattan this chapter with no travel beat."

**AuthorClaw today:** Continuity is implicit in the bible phase + the `series-bible` service. No per-chapter chronology pass. Plot-promises tracking (`plot-promises.ts`) gets close but is promise-shaped, not timeline-shaped.

**Author payoff:** Eliminates the most common reader-trust break in long-form AI fiction. The continuity-tracker agent in the user's existing Crucible review suite (`crucible-suite:timeline-checker`) confirms timeline error is its own discipline — worth modeling after that agent's prompt structure.

**Effort:** Low–medium. A new sub-step in Phase 3 that takes (chapter outline + prior chapters compressed + timeline doc) and answers "any conflicts?" Could land in a day for a flag-gated experimental version.

**Why this rank:** Directly addresses the #1 named continuity pain. Cheap to implement. High visible quality lift.

---

### 5. Explicit Style Check against a `prose_style.md` reference
**StoryHackerAI today:** Every chapter draft is checked against the genre's `prose_style.md` (voice, pacing, sample paragraphs). The Style Check is a distinct LLM pass before the final rewrite.

**AuthorClaw today:** `style-clone.ts` and `character-voices.ts` exist, but they're voice-fingerprinting tools used to *seed* generation, not *check* generation. The drafter sees the style guide; nothing audits the output against it.

**Author payoff:** Catches the voice drift that compounds over 30 chapters. Authors using a hand-tuned persona feel this acutely — the persona is fine on chapter 1 and bleeds into generic by chapter 25.

**Effort:** Low. Same shape as the Chronology Check — one prompt, one cheap-to-medium model, takes (chapter + style reference) and returns (pass | concrete revisions). Pairs with #4 in the same pipeline change.

---

### 6. Wordcount Estimator as a pre-draft sanity check
**StoryHackerAI today:** Before drafting each chapter, a cheap-model agent estimates how long the chapter will be based on the scene briefs. If the estimate is way off the target, the briefs get rewritten.

**AuthorClaw today:** No equivalent. The drafter writes the chapter, and if it comes back at 800 words against a 2,500 target, the author re-prompts. The error compounds across 30 chapters into a book that's the wrong length.

**Author payoff:** Catches outline-vs-chapter-count drift that today only surfaces at the end of Phase 3 when you compile the manuscript and discover it's 60k instead of 90k. Same intervention point flagged as a troubleshooting item in [FIRST-NOVEL-GUIDE.md](FIRST-NOVEL-GUIDE.md) ("Output too short for word target").

**Effort:** Very low. One cheap-model call per chapter with a structured-output prompt.

---

### 7. Stage re-runnability without re-running upstream
**StoryHackerAI today:** Stages 1–5 are independently invokable. Re-run Stage 3 (worldbuilding) without redoing Stages 1–2, because each stage reads its inputs from disk and writes its outputs to disk. The orchestrator's "All" mode reloads state between stages.

**AuthorClaw today:** The pipeline has `/stop` and `continue`, but those resume from where you stopped — they don't *replay an earlier phase*. To redo Phase 2 (Bible) after Phase 3 (Production) has started, you have to manually edit phase-output files and hope nothing downstream is invalidated.

**Author payoff:** First-book editing dramatically smoother. "Phase 2 produced a thin character bible — let me regenerate it with new prompts" becomes a one-command operation, not a reset.

**Effort:** Medium. The pipeline state machine has to learn the difference between "resume at last checkpoint" and "rerun phase N." Phase-output invalidation rules need defining (rerunning Phase 2 should invalidate Phase 3 outputs that haven't been hand-edited).

---

### 8. Loop-append single-file output for batched artifacts (characters / worldbuilding)
**StoryHackerAI today:** Stage 2 generates 8–12 characters, each appended to a single `02_characters.md` with `## <CharacterName>` headers. Same for `03_worldbuilding.md`. Authors get one file to scroll, edit, and share.

**AuthorClaw today:** Output files exist per project (`workspace/projects/<id>/01-planning/characters.md`) but follow the AuthorClaw convention of one file per artifact type, not loop-append.

**Author payoff:** Minor UX preference, but several authors prefer the single-file pattern for batched artifacts. Easier to grep, easier to edit, easier to paste into a reference doc.

**Effort:** Low. An output-mode config (`output.style: single-file | per-artifact`). Genuinely an opinion, not a fix.

---

## 🟨 TIER 3 — Useful but lower-leverage

### 9. Tighter cheap/mid/advanced model-tier semantics within a single phase
**StoryHackerAI today:** Stage 5 uses the cheap model for 6 sub-steps (selectors, briefs, wordcount), the medium/advanced model for 7 sub-steps (brief rewrite, draft, check, rewrite). Tier assignment is *per-step*, not *per-phase*.

**AuthorClaw today:** Per the README, tier routing is per-phase: planning/research = free, creative = mid, final editing = premium. Coarser-grained.

**Author payoff:** Cost reduction without quality loss. Today's "premium for the whole production phase" overspends on sub-tasks that a cheap model handles fine.

**Effort:** Low–medium. Requires step-level tier metadata in the project engine. Naturally falls out of #2 (the Selector → Brief → Draft → Check pattern), so do them together.

---

### 10. The `meta.json` per-novel convention
**StoryHackerAI today:** Each novel directory has a tiny `meta.json` like `{ "genre": "romantasy", "tense": "third person limited" }`. Workflows read it to know which genre templates to load and what tense to write in.

**AuthorClaw today:** Project metadata is stored in `workspace/.config/projects-state.json` — a single global file across all projects.

**Author payoff:** Per-project metadata next to the project files is more portable. Easier to ship a project to a collaborator, archive a finished book, or version-control a single novel.

**Effort:** Very low. Co-locate a `meta.json` (or `project.json`) in each project directory alongside its phase outputs.

---

### 11. Workflow-style stage transformer pattern
**StoryHackerAI today:** `workflows/_transform.mjs` (371 lines) auto-converts upstream Skool workflow JSONs into the local-filesystem variants. The five stage files are *generated*, not hand-written. Changes that should survive upstream re-imports live in the transformer, not in the JSON output.

**AuthorClaw equivalent:** N/A — AuthorClaw isn't a workflow-import system. But the *pattern* (codify the upstream→local delta as a transformer, regenerate on upstream change) is exactly the right pattern for [OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md) item #12 (ClawHub-style skill registry) and would also apply to absorbing OpenClaw `extensions/*` plugins as they arrive.

**Effort:** N/A for direct port. Worth borrowing the philosophy when designing the eventual skill-import pipeline.

---

## 🟩 TIER 4 — Out of scope for porting

### 12. n8n as a runtime
StoryHackerAI runs entirely inside n8n. AuthorClaw is a custom Node daemon with a custom dashboard. The workflow patterns inside StoryHackerAI's n8n graphs are portable (Tiers 1–3 above); n8n-the-runtime is not. AuthorClaw should not become n8n-based.

### 13. Google Docs in / Google Docs out
The upstream Story Hacker workflows used Google Docs for every read/write. StoryHackerAI ports *away* from that to local files. AuthorClaw also writes to local files. The Google Docs path is a non-feature, intentionally dropped.

### 14. The downloaded "Skool" workflow set as canonical
StoryHackerAI maintains a relationship with an upstream source-of-truth (`/home/paul/data/Writing/Skool/n8n_workflows/`). AuthorClaw has no equivalent upstream, doesn't need one.

---

## Suggested sprint order

If the goal is the largest visible step-up with the least architectural churn:

1. **#1 (OpenRouter as canonical gateway)** first. Unlocks every other item that benefits from cheap/mid/advanced tiering across many models. Also retires several entries in [OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md) (items #19, parts of #11).
2. **#4 (Chronology Check) + #5 (Style Check) + #6 (Wordcount Estimator)** together, as a "Phase 3 quality bundle." All three are short cheap-model passes that slot into the existing chapter loop without restructuring the pipeline.
3. **#3 (genre templates)** before #2 — because the multi-pass chapter pattern in #2 leans on a `prose_style.md` reference, which is one of the six template files in #3.
4. **#2 (Selector → Brief → Draft → Check)** as the big architectural item once #1 + #3 + #4–6 are stable. This is the "deep mode" pipeline upgrade.
5. **#7 (stage re-runnability)** alongside or after #2 — same pipeline-engine touch.
6. **#8, #9, #10** as polish during the same period.
7. Park Tier 4 entirely.

Compounding with the OpenClaw roadmap: items #1, #4, #5, #6 all become easier if [OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md) item #5 (embeddings provider) lands first, because Style Check and Chronology Check both benefit from semantic recall over prior chapters.

---

## Cross-reference index

- **[OPENCLAW-UPDATES.md](OPENCLAW-UPDATES.md)** — OpenClaw upstream features. Item #5 (embeddings), #11 (Pixverse), #12 (ClawHub), #19 (provider expansions) all touch the same surface as the StoryHackerAI items above.
- **[GOD-CLASS-REFACTOR.md](GOD-CLASS-REFACTOR.md)** — Level 3 plugin contracts for AI providers become trivially smaller once #1 (OpenRouter canonical gateway) is done — most of "the providers" collapse into "OpenRouter plus Ollama plus optional direct keys."
- **[FIRST-NOVEL-GUIDE.md](FIRST-NOVEL-GUIDE.md)** — the troubleshooting matrix names several pains that #4 / #5 / #6 directly resolve.
- **[../README.md](../README.md#documentation)** — top-level documentation index.
