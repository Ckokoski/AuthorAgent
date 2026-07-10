/**
 * AuthorAgent Prose Evolver — GEPA-style reflective prose evolution.
 *
 * The apex quality feature: iteratively improve a single prose passage by using
 * the WritingJudge as a TRAINING SIGNAL (fitness function), while preserving the
 * author's voice, and keeping an auditable trace of what changed and why.
 *
 * The loop is modelled on GEPA (Genetic-Pareto reflective prompt evolution),
 * adapted from "optimize a prompt" to "optimize a prose passage":
 *
 *   1. SCORE      — run the WritingJudge on the current best passage. This is a
 *                   numeric fitness score (0-100) plus SPECIFIC weaknesses
 *                   (the judge's retryFeedback / topIssues). This is the reward
 *                   model — the richer the score signal, the better the search.
 *   2. REFLECT    — ONE AI call. Given the passage + the judge's weaknesses +
 *                   the author's goal, diagnose the 2-3 HIGHEST-LEVERAGE,
 *                   specific improvements. NOT a rewrite — a plan. This is the
 *                   GEPA "reflection" step: natural-language credit assignment.
 *   3. REVISE     — ONE AI call ('revision' tier). Rewrite the passage applying
 *                   ONLY those improvements, explicitly preserving the author's
 *                   voice (soul/style-guide injected) and not changing
 *                   plot/meaning. This is the mutation operator.
 *   4. RE-SCORE   — run the judge on the candidate.
 *
 * PARETO / NO-REGRESSION RULE (the heart of GEPA):
 *   - We track the best-scoring passage seen so far (the frontier). A candidate
 *     is ACCEPTED as the new best ONLY if it strictly beats the current best
 *     score. We NEVER regress — a worse candidate is discarded and the previous
 *     best is retained.
 *   - When a round fails to improve, the NEXT round varies the reflection angle
 *     (a different diagnostic lens) so we don't re-propose the same losing edit.
 *   - After 2 consecutive non-improving rounds we stop early (the search has
 *     plateaued; more rounds just burn tokens).
 *
 * COST DISCIPLINE:
 *   - Rounds default to 3, hard-capped at 5.
 *   - Each round is ~3 AI calls: score (1 judge call) + reflect (1) + revise (1).
 *     (Dual-judge scoring would be 2 judge calls; we use single-judge scoring to
 *     keep the per-round cost at ~3.) Plus 1 initial score before the loop.
 *   - estimateCalls(rounds) exposes the worst-case budget up front.
 *
 * GRACEFUL DEGRADATION:
 *   - evolve() NEVER throws. Any AI/judge failure returns the best-so-far
 *     passage (falling back to the original) with a warning. A single failed
 *     round is skipped, not fatal.
 *
 * FITNESS-SIGNAL QUALITY:
 *   - The judge is only as good as the tier it scores on. On the FREE tier the
 *     score signal is weak and noisy — a premium judge is strongly recommended
 *     for real evolution. The scoring provider is chosen via a DECENT-tier task
 *     type ('final_edit' → premium, falling back gracefully) so scoring quality
 *     is prioritized independently of the (mid-tier) revision calls.
 */

import type {
  WritingJudgeService,
  AICompleteFn,
  AISelectProviderFn,
  QualityVerdict,
} from './writing-judge.js';
import type { SoulService } from './soul.js';
import type { MemoryTierService } from './memory-tier.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface EvolveInput {
  /** The prose passage to evolve. */
  passage: string;
  /** Optional project id — enables CORE story-memory context (keeps revisions
   *  consistent with the manuscript) when a memoryTier is supplied. */
  projectId?: string;
  /** Optional author goal — steers reflection ("tighten the pacing", "make the
   *  dread land harder", "cut the throat-clearing"). Free text. */
  goal?: string;
  /** Number of evolution rounds. Default 3, hard-capped at MAX_ROUNDS (5). */
  rounds?: number;
  /** Preserve the author's voice by injecting soul/style-guide into the revise
   *  prompt. Default true — pass false only to explicitly allow free rewrites. */
  preserveVoice?: boolean;
}

/** Dependencies injected per-call (the service is otherwise stateless). */
export interface EvolveDeps {
  /** The evaluator / fitness function. Required. */
  writingJudge: WritingJudgeService;
  /** Router completion closure. Required for reflection + revision. */
  aiComplete: AICompleteFn;
  /** Router provider-selection closure. Required. */
  aiSelectProvider: AISelectProviderFn;
  /** Author voice source. Optional — when absent, voice preservation degrades
   *  to a generic "keep the author's voice" instruction. */
  soul?: SoulService | null;
  /** CORE story-memory source. Optional — when present + projectId supplied,
   *  a short manuscript-consistency block is injected into the revise prompt. */
  memoryTier?: MemoryTierService | null;
}

/** One recorded evolution round in the auditable trace. */
export interface EvolveRound {
  /** 1-based round number. */
  round: number;
  /** The candidate's judge score (0-100), or null if the round failed to score. */
  candidateScore: number | null;
  /** True if the candidate strictly beat the running best and was kept. */
  accepted: boolean;
  /** The reflection step's diagnosis (the 2-3 highest-leverage improvements). */
  reflection: string;
  /** A short human summary of what this round changed / why it was kept/rejected. */
  changeSummary: string;
  /** The diagnostic lens used this round (varies after a non-improving round). */
  angle: string;
}

export interface EvolutionResult {
  original: { text: string; score: number };
  best: { text: string; score: number };
  /** True if best strictly improved on the original. */
  improved: boolean;
  rounds: EvolveRound[];
  /** Total AI calls actually made (judge + reflect + revise across all rounds). */
  totalCalls: number;
  /** The provider id used for the (mid-tier) revision calls, for cost attribution. */
  provider: string;
  /** True when voice-preservation was requested AND soul/style context was injected. */
  voicePreserved: boolean;
  /** Non-fatal warnings (AI failures, weak-signal notes, degraded context). */
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════
// Tuning constants
// ═══════════════════════════════════════════════════════════

/** Default number of evolution rounds. */
export const DEFAULT_ROUNDS = 3;
/** Hard cap on rounds — cost ceiling. */
export const MAX_ROUNDS = 5;
/** Minimum passage length (chars) worth evolving — below this the loop is a no-op. */
export const MIN_PASSAGE_CHARS = 40;
/** Stop after this many consecutive non-improving rounds (search plateaued). */
export const PLATEAU_STOP = 2;
/** AI calls per round: score + reflect + revise. */
export const CALLS_PER_ROUND = 3;

/**
 * Reflection lenses. The first round uses lens[0]; after a non-improving round
 * we advance to the next lens so we don't re-propose the same losing edit. This
 * is the GEPA "try a different mutation direction" behaviour.
 */
const REFLECTION_ANGLES = [
  'highest-leverage line-level craft (show-don\'t-tell, weak verbs, filter words, cliché, adverb crutches)',
  'rhythm, sentence variety, and momentum (vary cadence; cut throat-clearing; sharpen the strongest image)',
  'emotional truth and subtext (make the feeling land through gesture/physiology, not labels; deepen implication)',
  'compression and precision (remove every word that isn\'t working; concretize the abstract)',
] as const;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class ProseEvolverService {
  /**
   * Estimate the worst-case AI-call budget for a given round count. Useful for
   * surfacing cost to the user BEFORE running. Worst case = 1 initial score +
   * CALLS_PER_ROUND per round (score + reflect + revise). Early stopping and
   * failed rounds only ever make the actual count LOWER than this.
   */
  estimateCalls(rounds: number = DEFAULT_ROUNDS): number {
    const r = this.clampRounds(rounds);
    // 1 initial score, then up to CALLS_PER_ROUND per round.
    return 1 + r * CALLS_PER_ROUND;
  }

  private clampRounds(rounds: number | undefined): number {
    if (typeof rounds !== 'number' || !Number.isFinite(rounds)) return DEFAULT_ROUNDS;
    return Math.max(1, Math.min(MAX_ROUNDS, Math.floor(rounds)));
  }

  /**
   * Evolve a prose passage. Never throws — on any failure it returns the
   * best-so-far (falling back to the original) with a warning.
   */
  async evolve(input: EvolveInput, deps: EvolveDeps): Promise<EvolutionResult> {
    const warnings: string[] = [];
    const rounds = this.clampRounds(input.rounds);
    const preserveVoice = input.preserveVoice !== false;
    const original = (input.passage ?? '').toString();

    // Resolve the revision provider once, for cost attribution + a stable label.
    // Never throws — falls back to a synthetic id if selection fails.
    let revisionProviderId = 'unknown';
    try {
      revisionProviderId = deps.aiSelectProvider('revision')?.id || 'unknown';
    } catch {
      revisionProviderId = 'unknown';
    }

    // Build the voice + memory context once (both optional, both best-effort).
    const voiceContext = preserveVoice ? this.buildVoiceContext(deps, warnings) : '';
    const voicePreserved = preserveVoice && voiceContext.trim().length > 0;
    const memoryContext = this.buildMemoryContext(input, deps, warnings);

    // ── Initial score (fitness of the original) ──
    let totalCalls = 0;
    const scoringSelect = this.makeScoringSelector(deps.aiSelectProvider);

    const originalVerdict = await this.scoreSafe(original, deps, scoringSelect, warnings);
    totalCalls += originalVerdict.calls;
    const originalScore = originalVerdict.verdict?.score ?? 0;
    if (!originalVerdict.verdict) {
      warnings.push('Could not score the original passage (AI/judge unavailable). Evolution ran without a reliable baseline; returning the original.');
    } else if (originalVerdict.usedFreeSignal) {
      warnings.push('Scoring ran on a FREE/degraded tier — the fitness signal is weak and noisy. A premium judge (Claude/OpenAI) is strongly recommended for reliable prose evolution.');
    }

    // Frontier: best-so-far. Seeded with the original.
    let bestText = original;
    let bestScore = originalScore;
    let bestVerdict: QualityVerdict | null = originalVerdict.verdict;

    const trace: EvolveRound[] = [];
    let angleIndex = 0;
    let nonImproving = 0;

    // If the original is too short to meaningfully evolve, skip the loop but
    // still return a well-formed result (no throw).
    const tooShort = original.trim().length < MIN_PASSAGE_CHARS;
    if (tooShort) {
      warnings.push(`Passage under ${MIN_PASSAGE_CHARS} characters — too short to evolve; returned unchanged.`);
    }

    for (let round = 1; round <= rounds && !tooShort; round++) {
      const angle = REFLECTION_ANGLES[Math.min(angleIndex, REFLECTION_ANGLES.length - 1)];

      // The weaknesses feeding reflection come from the CURRENT BEST's judge
      // verdict (credit assignment against the frontier, not a stale draft).
      const weaknesses = this.extractWeaknesses(bestVerdict);

      // ── REFLECT (1 AI call) ──
      const reflectRes = await this.reflectSafe(
        { passage: bestText, weaknesses, goal: input.goal, angle },
        deps,
        warnings,
        round,
      );
      totalCalls += reflectRes.calls;
      const reflection = reflectRes.text;

      if (!reflection) {
        // Reflection failed — record the round as a no-op and count it toward
        // the plateau so we don't spin uselessly.
        trace.push({
          round,
          candidateScore: null,
          accepted: false,
          reflection: '',
          changeSummary: 'Reflection step failed (AI unavailable); round skipped, best retained.',
          angle,
        });
        nonImproving++;
        angleIndex++;
        if (nonImproving >= PLATEAU_STOP) {
          warnings.push(`Stopped after ${round} round(s): ${PLATEAU_STOP} consecutive non-improving rounds.`);
          break;
        }
        continue;
      }

      // ── REVISE (1 AI call, 'revision' tier) ──
      const reviseRes = await this.reviseSafe(
        { passage: bestText, reflection, goal: input.goal, voiceContext, memoryContext, preserveVoice },
        deps,
        warnings,
        round,
      );
      totalCalls += reviseRes.calls;
      const candidate = reviseRes.text;

      if (!candidate || candidate.trim().length < MIN_PASSAGE_CHARS) {
        trace.push({
          round,
          candidateScore: null,
          accepted: false,
          reflection,
          changeSummary: 'Revision step produced no usable candidate; best retained.',
          angle,
        });
        nonImproving++;
        angleIndex++;
        if (nonImproving >= PLATEAU_STOP) {
          warnings.push(`Stopped after ${round} round(s): ${PLATEAU_STOP} consecutive non-improving rounds.`);
          break;
        }
        continue;
      }

      // ── RE-SCORE the candidate ──
      const candVerdict = await this.scoreSafe(candidate, deps, scoringSelect, warnings);
      totalCalls += candVerdict.calls;
      const candidateScore = candVerdict.verdict?.score ?? null;

      // ── PARETO / NO-REGRESSION: keep ONLY if it strictly beats the best. ──
      // If we couldn't score the candidate, we cannot prove improvement, so we
      // never regress onto an unscored candidate.
      const improvedThisRound = candidateScore !== null && candidateScore > bestScore;

      let changeSummary: string;
      if (improvedThisRound) {
        const delta = Math.round((candidateScore! - bestScore) * 10) / 10;
        changeSummary = `Accepted: score ${bestScore} → ${candidateScore} (+${delta}). Applied "${angle.split('(')[0].trim()}" edits.`;
        bestText = candidate;
        bestScore = candidateScore!;
        bestVerdict = candVerdict.verdict;
        nonImproving = 0;
        // On success, keep the same productive lens for the next round.
      } else {
        const scoreNote = candidateScore === null
          ? 'candidate could not be scored'
          : `candidate scored ${candidateScore} ≤ best ${bestScore}`;
        changeSummary = `Rejected: ${scoreNote}. Best retained; next round tries a different angle.`;
        nonImproving++;
        angleIndex++; // vary the reflection lens next round
      }

      trace.push({
        round,
        candidateScore,
        accepted: improvedThisRound,
        reflection,
        changeSummary,
        angle,
      });

      if (nonImproving >= PLATEAU_STOP) {
        warnings.push(`Stopped after ${round} round(s): ${PLATEAU_STOP} consecutive non-improving rounds (search plateaued).`);
        break;
      }
    }

    const improved = bestScore > originalScore && bestText !== original;

    return {
      original: { text: original, score: round2(originalScore) },
      best: { text: bestText, score: round2(bestScore) },
      improved,
      rounds: trace,
      totalCalls,
      provider: revisionProviderId,
      voicePreserved,
      warnings,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Scoring (fitness) — wraps WritingJudge.evaluate defensively
  // ─────────────────────────────────────────────────────────

  /**
   * Build a provider selector for SCORING that upgrades the judge's tier to a
   * DECENT one. The WritingJudge internally asks for the 'revision' (mid) tier;
   * we intercept and route scoring calls to 'final_edit' (premium) so the
   * fitness signal is as strong as the user's configured providers allow. If
   * premium isn't configured, tier routing degrades gracefully to whatever is
   * available (mid/free) — we never fail selection here.
   */
  private makeScoringSelector(base: AISelectProviderFn): AISelectProviderFn {
    return (_taskType: string) => {
      try {
        // 'final_edit' maps to the premium tier in the router; 'consistency'
        // is the mid-tier fallback the router already elevates for reasoning.
        return base('final_edit');
      } catch {
        try {
          return base('consistency');
        } catch {
          // Last resort — let the original selection run so evaluate can still
          // attempt a call (or fall back to mechanical-only inside the judge).
          return base(_taskType);
        }
      }
    };
  }

  /**
   * Score a passage via the WritingJudge. Returns the verdict (or null on
   * failure), the number of AI calls it cost (1 judge call when AI is wired, 0
   * when it degrades to mechanical-only), and whether the score came from a
   * free/degraded provider (weak signal). Never throws.
   */
  private async scoreSafe(
    text: string,
    deps: EvolveDeps,
    scoringSelect: AISelectProviderFn,
    warnings: string[],
  ): Promise<{ verdict: QualityVerdict | null; calls: number; usedFreeSignal: boolean }> {
    // Detect whether the scoring provider is a free tier, to flag a weak signal.
    let usedFreeSignal = false;
    try {
      const chosen: any = scoringSelect('final_edit');
      const id = (chosen?.id || '').toLowerCase();
      // Ollama + Gemini are the free-tier providers in this router.
      usedFreeSignal = id === 'ollama' || id === 'gemini';
    } catch {
      /* selection probing failed — leave usedFreeSignal false, evaluate handles it */
    }

    try {
      const verdict = await deps.writingJudge.evaluate(text, {
        aiComplete: deps.aiComplete,
        aiSelectProvider: scoringSelect,
        runLLMJudge: true,
        // Single-judge (craft) scoring keeps the per-round cost at ~3 calls.
        dualJudge: false,
      });
      // If the judge fell back to mechanical-only (LLM unavailable/non-JSON), the
      // verdict.judge is null — that's a degraded signal too.
      if (!verdict.judge && !verdict.dualJudge) {
        usedFreeSignal = true;
      }
      const calls = verdict.judge || verdict.dualJudge ? 1 : 0;
      return { verdict, calls, usedFreeSignal };
    } catch (err) {
      warnings.push(`Judge scoring failed: ${(err as Error)?.message || String(err)}. Proceeding with best-so-far.`);
      return { verdict: null, calls: 0, usedFreeSignal };
    }
  }

  /** Pull the judge's specific weaknesses into a compact steering string. */
  private extractWeaknesses(verdict: QualityVerdict | null): string {
    if (!verdict) return '(no judge feedback available — infer weaknesses from the prose itself)';
    const parts: string[] = [];
    if (verdict.retryFeedback && verdict.retryFeedback.trim().length > 0) {
      parts.push(verdict.retryFeedback.trim());
    } else {
      // Fall back to the judge/dualJudge top issues if retryFeedback was empty.
      const top = verdict.judge?.topIssues
        ?? verdict.dualJudge?.craft.topIssues
        ?? [];
      for (const t of top) parts.push(`- ${t}`);
      // Mechanical issues as a secondary source.
      for (const m of verdict.mechanical.issues.slice(0, 4)) {
        parts.push(`- ${m.description}`);
      }
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0
      ? joined
      : '(the judge found no specific weaknesses — look for the single highest-leverage improvement)';
  }

  // ─────────────────────────────────────────────────────────
  // Reflection (GEPA credit assignment) — one AI call
  // ─────────────────────────────────────────────────────────

  private async reflectSafe(
    args: { passage: string; weaknesses: string; goal?: string; angle: string },
    deps: EvolveDeps,
    warnings: string[],
    round: number,
  ): Promise<{ text: string; calls: number }> {
    const system = `You are a ruthless line editor performing REFLECTION, not rewriting.

Given a prose passage, the automated judge's specific weaknesses, and an optional author goal, identify the 2-3 HIGHEST-LEVERAGE, concrete improvements that would most raise the prose quality. Focus this pass on: ${args.angle}.

RULES:
- Do NOT rewrite the passage. Diagnose only.
- Each point must be SPECIFIC and actionable — name the exact problem and the exact fix direction (quote the offending phrase where useful).
- Prioritize ruthlessly: 2-3 changes that matter, not a laundry list.
- Never propose changes that would alter the plot, meaning, or the author's voice.
- Output as a short numbered list. No preamble, no rewrite.`;

    const goalLine = args.goal && args.goal.trim().length > 0
      ? `AUTHOR GOAL: ${args.goal.trim()}\n\n`
      : '';

    const user = `${goalLine}JUDGE'S WEAKNESSES:\n${args.weaknesses}\n\nPASSAGE:\n${args.passage}\n\nList the 2-3 highest-leverage improvements (this pass's focus: ${args.angle}).`;

    try {
      const provider = deps.aiSelectProvider('revision');
      const res = await deps.aiComplete({
        provider: provider.id,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 500,
        temperature: 0.4,
      });
      const text = (res?.text || '').trim();
      if (!text) {
        warnings.push(`Round ${round}: reflection returned empty; skipping round.`);
        return { text: '', calls: 1 };
      }
      return { text, calls: 1 };
    } catch (err) {
      warnings.push(`Round ${round}: reflection call failed: ${(err as Error)?.message || String(err)}.`);
      return { text: '', calls: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────
  // Revision (mutation operator) — one AI call, 'revision' tier
  // ─────────────────────────────────────────────────────────

  private async reviseSafe(
    args: {
      passage: string;
      reflection: string;
      goal?: string;
      voiceContext: string;
      memoryContext: string;
      preserveVoice: boolean;
    },
    deps: EvolveDeps,
    warnings: string[],
    round: number,
  ): Promise<{ text: string; calls: number }> {
    // The revise prompt EXPLICITLY instructs voice preservation + no
    // plot/meaning change, and injects the author's soul/style-guide when
    // preserveVoice is on. This is what keeps the evolution "in voice".
    const voiceBlock = args.preserveVoice
      ? (args.voiceContext.trim().length > 0
          ? `PRESERVE THE AUTHOR'S VOICE. The revised passage MUST read as if the same author wrote it. Match diction, rhythm, sentence shape, and tone to the profile below. Do not smooth the prose into generic "correct" writing.\n\n=== AUTHOR VOICE / STYLE GUIDE ===\n${args.voiceContext.trim()}\n=== END VOICE ===\n\n`
          : `PRESERVE THE AUTHOR'S VOICE — match the diction, rhythm, sentence shape, and tone already present in the passage. Do not smooth it into generic "correct" prose.\n\n`)
      : '';

    const memoryBlock = args.memoryContext.trim().length > 0
      ? `STAY CONSISTENT WITH THE MANUSCRIPT. Do not contradict the established facts below.\n\n${args.memoryContext.trim()}\n\n`
      : '';

    const goalLine = args.goal && args.goal.trim().length > 0
      ? `AUTHOR GOAL (honor it): ${args.goal.trim()}\n\n`
      : '';

    const system = `You are a master prose reviser executing a targeted edit pass.

${voiceBlock}${memoryBlock}Apply ONLY the specific improvements listed below. Do not add new plot, new events, or new meaning. Do not change what happens or what anything means — only HOW it is written. Keep the passage the same length or tighter.

Return ONLY the revised passage. No commentary, no preamble, no markdown code fences, no notes about what you changed.`;

    const user = `${goalLine}IMPROVEMENTS TO APPLY (and nothing else):\n${args.reflection}\n\nORIGINAL PASSAGE:\n${args.passage}\n\nReturn the revised passage now.`;

    try {
      const provider = deps.aiSelectProvider('revision');
      const res = await deps.aiComplete({
        provider: provider.id,
        system,
        messages: [{ role: 'user', content: user }],
        // Room for a full rewrite of the passage; revision is length-heavy.
        maxTokens: 4000,
        temperature: 0.7,
      });
      let text = (res?.text || '').trim();
      // Defensive: strip accidental code fences the model may add despite the
      // instruction, so downstream scoring sees clean prose.
      text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
      if (!text) {
        warnings.push(`Round ${round}: revision returned empty; best retained.`);
        return { text: '', calls: 1 };
      }
      return { text, calls: 1 };
    } catch (err) {
      warnings.push(`Round ${round}: revision call failed: ${(err as Error)?.message || String(err)}.`);
      return { text: '', calls: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────
  // Context builders (voice + memory) — both best-effort
  // ─────────────────────────────────────────────────────────

  /** Build the author-voice context from the soul service. Never throws. Capped. */
  private buildVoiceContext(deps: EvolveDeps, warnings: string[]): string {
    if (!deps.soul) return '';
    try {
      const full = deps.soul.getFullContext?.() || '';
      // Cap so a huge soul doc doesn't blow the revise prompt budget. The style
      // signal lives in the first chunk (personality + style guide + voice).
      const capped = full.length > 3500 ? full.slice(0, 3500) : full;
      return capped.trim();
    } catch (err) {
      warnings.push(`Voice context unavailable: ${(err as Error)?.message || String(err)}. Revisions used a generic voice-preservation instruction.`);
      return '';
    }
  }

  /**
   * Build a short manuscript-consistency block from CORE story memory. Uses the
   * MemoryTier.buildCore read (pure, never AI-calls, never throws). Requires a
   * projectId. Capped so it stays a lightweight consistency guard, not a huge
   * context dump.
   */
  private buildMemoryContext(input: EvolveInput, deps: EvolveDeps, warnings: string[]): string {
    if (!deps.memoryTier || !input.projectId) return '';
    try {
      // activeChapterNumber 0 + the passage as promptText → surfaces the
      // characters/threads relevant to THIS passage. buildCore is a pure read.
      const core = deps.memoryTier.buildCore(input.projectId, 0, input.passage ?? '');
      if (!core || core.trim().length === 0) return '';
      // Keep it lightweight — the revise prompt is dominated by the passage.
      return core.length > 1800 ? core.slice(0, 1800) : core;
    } catch (err) {
      warnings.push(`Story-memory context unavailable: ${(err as Error)?.message || String(err)}. Revisions ran without manuscript consistency context.`);
      return '';
    }
  }
}

/** Round to one decimal place (scores are 0-100 with one decimal of precision). */
function round2(n: number): number {
  return Math.round(n * 10) / 10;
}
