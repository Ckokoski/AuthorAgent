/**
 * AuthorAgent Revision Orchestrator
 *
 * Replaces the one-monolithic-revision approach with a coordinated set of
 * NARROW EXPERT PASSES. Each pass is a specialist: it owns its own checklist,
 * its own analyzer, and its own cost-appropriate model tier. Their outputs are
 * aggregated, deduped, and prioritized into ONE unified findings report.
 *
 * Why specialist passes instead of one big "revise this chapter" call?
 *   - A continuity editor and a line editor look for completely different
 *     things. Asking one model to do both in one prompt produces shallow,
 *     unfocused feedback and wastes premium tokens on cheap work.
 *   - Each pass gets to route to the RIGHT tier: continuity (a cross-chapter
 *     reasoning problem) wants a premium/consistency-tier model; anti-slop
 *     (a regex screen) needs no AI at all and must never burn a token.
 *   - One failing pass must never abort the rest — each runs in its own
 *     try/catch and, on failure, is reported in `passesSkipped`.
 *
 * The passes:
 *   1. continuity  — ACTIVE CONTRADICTION DETECTION. When a ContradictionDetector
 *                    is wired, the pass diffs the CHAPTER TEXT against the
 *                    project's entity DB + prior summaries (evidence-chained,
 *                    categorized findings). If no detector is available it falls
 *                    back to ContextEngine.runContinuityCheck (whole-index diff).
 *                    tier 'consistency'. Needs a projectId.
 *   2. voice       — CharacterVoices drift detection for the chapter dialogue.
 *                    tier 'style_analysis'. Needs a projectId + entity DB.
 *   3. craft       — CraftCritic + DialogueAuditor (local heuristics).
 *                    tier 'revision'.
 *   4. anti-slop   — WritingJudge.mechanicalScreen (FREE regex; no AI call).
 *   5. fact        — DEFERRED stub. Documented TODO; research wiring is heavy.
 *
 * Cost discipline: tiers are honored via aiSelectProvider(taskType) per pass.
 * anti-slop is fully mechanical. We never force premium everywhere.
 */

import type { ContextEngine, ContinuityIssue, AICompleteFn, AISelectProviderFn } from './context-engine.js';
import type { CharacterVoicesService } from './character-voices.js';
import type { StyleCloneService } from './style-clone.js';
import type { CraftCriticService } from './craft-critic.js';
import type { DialogueAuditor } from './dialogue-auditor.js';
import type { WritingJudgeService } from './writing-judge.js';
import type { ContradictionDetector, Contradiction } from './contradiction-detector.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type FindingSeverity = 'error' | 'warning' | 'info';

/** A single normalized issue produced by any specialist pass. */
export interface Finding {
  /** The pass that produced this finding (e.g. 'continuity', 'anti-slop'). */
  pass: string;
  /** The pass-specific category (e.g. 'character', 'ai_tell', 'telling'). */
  category: string;
  severity: FindingSeverity;
  /** Optional location hint — a chapter id, paragraph index, character name… */
  location?: string;
  /** What is wrong. */
  description: string;
  /** How to fix it, when the analyzer offered one. */
  suggestion?: string;
}

export interface RevisionReport {
  projectId?: string;
  chapterId?: string;
  generatedAt: string;
  totalFindings: number;
  findingsBySeverity: Record<FindingSeverity, number>;
  findingsByPass: Record<string, number>;
  findings: Finding[];
  /** Passes that ran (successfully or with zero findings). */
  passesRun: string[];
  /** Passes that were requested but skipped — either because their analyzer
   *  was missing, a prerequisite (projectId) was absent, or the pass threw. */
  passesSkipped: string[];
}

export interface RevisionAnalyzeInput {
  projectId?: string;
  chapterText: string;
  chapterId?: string;
  /** Optional filter — run only these passes (by name). Unknown names are
   *  ignored; omitting the field runs every registered pass. */
  passes?: string[];
}

/** The specialist analyzers this orchestrator composes. All optional/nullable:
 *  a pass whose analyzer is missing is skipped gracefully. */
export interface RevisionOrchestratorDeps {
  contextEngine?: ContextEngine | null;
  characterVoices?: CharacterVoicesService | null;
  styleClone?: StyleCloneService | null;
  craftCritic?: CraftCriticService | null;
  dialogueAuditor?: DialogueAuditor | null;
  writingJudge?: WritingJudgeService | null;
  /** Active contradiction detector. When present, the continuity pass diffs the
   *  chapter text against the entity DB + prior summaries (evidence-chained).
   *  When absent, the continuity pass falls back to
   *  ContextEngine.runContinuityCheck. Optional → graceful fallback. */
  contradictionDetector?: ContradictionDetector | null;
  /** Closure that performs an AI completion (from AIRouter.complete). */
  aiComplete?: AICompleteFn | null;
  /** Closure that selects a provider for a task type (from
   *  AIRouter.selectProvider) — used to honor per-pass cost tiers. */
  aiSelectProvider?: AISelectProviderFn | null;
}

/** Canonical ordering of severities for sorting (error first). */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** The registered pass names, in their canonical run/sort order. */
export const REVISION_PASSES = ['continuity', 'voice', 'craft', 'anti-slop', 'fact'] as const;
export type RevisionPassName = (typeof REVISION_PASSES)[number];

// ═══════════════════════════════════════════════════════════
// Orchestrator
// ═══════════════════════════════════════════════════════════

export class RevisionOrchestrator {
  private deps: RevisionOrchestratorDeps;

  constructor(deps: RevisionOrchestratorDeps = {}) {
    this.deps = deps;
  }

  /**
   * Run the specialist revision passes and aggregate their findings into one
   * prioritized report. Each pass is isolated: a throwing pass never aborts
   * the others and is listed in `passesSkipped`.
   */
  async analyze(input: RevisionAnalyzeInput): Promise<RevisionReport> {
    const chapterText = input.chapterText || '';
    const wanted = this.resolveRequestedPasses(input.passes);

    const findings: Finding[] = [];
    const passesRun: string[] = [];
    const passesSkipped: string[] = [];

    // Each entry is (passName, runner). Runners return the findings they
    // produced, or throw. A pass that is intentionally not-applicable (e.g.
    // its analyzer is missing, or continuity has no projectId) records itself
    // as skipped without throwing.
    const passRunners: Array<{ name: RevisionPassName; run: () => Promise<Finding[]> }> = [
      { name: 'continuity', run: () => this.runContinuityPass(input) },
      { name: 'voice',      run: () => this.runVoicePass(input) },
      { name: 'craft',      run: () => this.runCraftPass(chapterText, input.chapterId) },
      { name: 'anti-slop',  run: () => this.runAntiSlopPass(chapterText, input.chapterId) },
      { name: 'fact',       run: () => this.runFactPass(input) },
    ];

    for (const pass of passRunners) {
      if (!wanted.has(pass.name)) continue;
      try {
        const produced = await pass.run();
        if (produced === SKIP) {
          passesSkipped.push(pass.name);
          continue;
        }
        findings.push(...produced);
        passesRun.push(pass.name);
      } catch (err) {
        // One pass failing must never abort the rest. Record it and move on.
        passesSkipped.push(pass.name);
      }
    }

    const deduped = this.dedupe(findings);
    const sorted = this.sort(deduped);

    const findingsBySeverity: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
    const findingsByPass: Record<string, number> = {};
    for (const f of sorted) {
      findingsBySeverity[f.severity]++;
      findingsByPass[f.pass] = (findingsByPass[f.pass] ?? 0) + 1;
    }

    return {
      projectId: input.projectId,
      chapterId: input.chapterId,
      generatedAt: new Date().toISOString(),
      totalFindings: sorted.length,
      findingsBySeverity,
      findingsByPass,
      findings: sorted,
      passesRun,
      passesSkipped,
    };
  }

  // ── Pass 1: continuity (tier 'consistency', mid reasoning) ──
  //
  // UPGRADED to ACTIVE CONTRADICTION DETECTION. When a ContradictionDetector is
  // wired, the pass diffs THE CHAPTER TEXT against the project's entity DB +
  // prior summaries and returns evidence-chained, categorized contradictions.
  // When no detector is available, it falls back to the original whole-index
  // ContextEngine.runContinuityCheck. The guard means the upgrade is additive:
  // a deployment without the detector behaves exactly as before.

  private async runContinuityPass(input: RevisionAnalyzeInput): Promise<Finding[]> {
    const engine = this.deps.contextEngine;
    // Requires the project's persisted entity DB to diff against.
    if (!engine || !input.projectId || !this.deps.aiComplete || !this.deps.aiSelectProvider) {
      return SKIP;
    }

    // Honor the cost tier: continuity is a cross-chapter reasoning problem →
    // route it to the consistency tier (mid). (The detector routes internally
    // too; selecting here keeps the tier intent observable for the fallback
    // path and for tier-routing assertions.)
    this.deps.aiSelectProvider('consistency');

    // ── Preferred path: active contradiction detection on the chapter text ──
    const detector = this.deps.contradictionDetector;
    if (detector) {
      // Pull the canonical entity DB + prior summaries from the engine's cached
      // context (pure in-memory reads — never AI-call, never throw).
      const entities = engine.getEntities(input.projectId);
      const priorSummaries = engine.getSummaries(input.projectId);

      const report = await detector.detect(
        {
          projectId: input.projectId,
          chapterText: input.chapterText || '',
          chapterId: input.chapterId,
          priorSummaries,
          entities,
        },
        this.deps.aiComplete,
        this.deps.aiSelectProvider,
      );

      return (report?.contradictions ?? []).map((c: Contradiction) => ({
        pass: 'continuity',
        // Category carries the taxonomy category + subtype so the UI can group
        // by both (e.g. "CHARACTER/trait").
        category: `${c.category}/${c.subtype}`,
        severity: c.severity,
        location: c.entity || input.chapterId,
        // Fold the evidence chain into the description so a Finding stays a
        // flat shape while still carrying the defensible both-sides evidence.
        description: this.formatContradiction(c),
        suggestion: c.suggestion || undefined,
      }));
    }

    // ── Fallback path: original whole-index continuity check ──
    const report = await engine.runContinuityCheck(
      input.projectId,
      this.deps.aiComplete,
      this.deps.aiSelectProvider,
    );

    return (report?.issues ?? []).map((issue: ContinuityIssue) => ({
      pass: 'continuity',
      category: issue.category,
      severity: issue.severity,
      location: issue.chapters?.length ? issue.chapters.join(', ') : undefined,
      description: issue.description,
      suggestion: issue.suggestion || undefined,
    }));
  }

  /** Render a Contradiction into a self-contained, evidence-chained description. */
  private formatContradiction(c: Contradiction): string {
    const parts: string[] = [];
    if (c.description) parts.push(c.description);
    const evidence: string[] = [];
    if (c.chapterEvidence) evidence.push(`this chapter: "${c.chapterEvidence}"`);
    if (c.priorEvidence) evidence.push(`established: "${c.priorEvidence}"`);
    if (evidence.length) parts.push(`[${evidence.join(' vs. ')}]`);
    return parts.join(' ') || 'Contradiction detected';
  }

  // ── Pass 2: voice (tier 'style_analysis', mid) ──

  private async runVoicePass(input: RevisionAnalyzeInput): Promise<Finding[]> {
    const cv = this.deps.characterVoices;
    const engine = this.deps.contextEngine;
    if (!cv || !input.projectId) return SKIP;

    // Voice drift is a statistical (StyleClone) comparison — no AI cost — but
    // it belongs to the style_analysis tier conceptually. Select it so the
    // pass's tier intent is honored/observable even though the compute is local.
    this.deps.aiSelectProvider?.('style_analysis');

    // Character names come from the project's entity DB (canonical index).
    let characterNames: string[] = [];
    const characterAliases: Record<string, string[]> = {};
    if (engine) {
      const characters = engine.getEntitiesByType(input.projectId, 'character');
      for (const c of characters) {
        characterNames.push(c.name);
        if (c.aliases?.length) characterAliases[c.name] = c.aliases;
      }
    }
    if (characterNames.length === 0) {
      // No known characters to attribute dialogue to → nothing to compare.
      return SKIP;
    }

    const report = await cv.detectDrift({
      projectId: input.projectId,
      chapterNumber: 0,
      chapterText: input.chapterText,
      characterNames,
      characterAliases,
    });

    const findings: Finding[] = [];
    for (const character of report.characters ?? []) {
      for (const flag of character.flags ?? []) {
        findings.push({
          pass: 'voice',
          category: 'voice_drift',
          // Drift is a soft signal — could be intentional. Warn, don't error.
          severity: 'warning',
          location: flag.characterName,
          description: `${flag.characterName}: ${flag.marker} drift (expected ~${flag.expected}, got ${flag.actual}, z=${flag.zScore}).`,
          suggestion: flag.note,
        });
      }
    }
    return findings;
  }

  // ── Pass 3: craft (tier 'revision', mid) — CraftCritic + DialogueAuditor ──

  private async runCraftPass(chapterText: string, chapterId?: string): Promise<Finding[]> {
    const critic = this.deps.craftCritic;
    const auditor = this.deps.dialogueAuditor;
    if (!critic && !auditor) return SKIP;

    // Both analyzers are local heuristics, but the craft pass belongs to the
    // 'revision' tier — select it so the pass's tier intent is honored/observable.
    this.deps.aiSelectProvider?.('revision');

    const findings: Finding[] = [];

    if (critic) {
      const report = critic.analyze('revision-pass', [
        { id: chapterId ?? 'chapter', number: 1, title: chapterId ?? 'Chapter', text: chapterText },
      ]);
      for (const flag of report.flags ?? []) {
        findings.push({
          pass: 'craft',
          category: flag.category,
          severity: flag.severity,
          location: chapterId,
          description: flag.description,
          suggestion: flag.suggestion,
        });
      }
    }

    if (auditor) {
      const report = auditor.audit(chapterText, chapterId);
      for (const flag of report.flags ?? []) {
        findings.push({
          pass: 'craft',
          category: 'dialogue',
          severity: flag.severity,
          location: flag.speaker || chapterId,
          description: flag.reason,
          suggestion: undefined,
        });
      }
    }

    return findings;
  }

  // ── Pass 4: anti-slop (FREE — mechanical regex only, no AI) ──

  private runAntiSlopPass(chapterText: string, chapterId?: string): Promise<Finding[]> {
    const judge = this.deps.writingJudge;
    if (!judge) return Promise.resolve(SKIP);

    // NO aiSelectProvider / aiComplete call here — this pass must stay free.
    const report = judge.mechanicalScreen(chapterText);

    const findings: Finding[] = (report.issues ?? []).map(issue => ({
      pass: 'anti-slop',
      category: issue.category,
      severity: issue.severity,
      location: chapterId,
      description: issue.description,
      suggestion: issue.examples?.length
        ? `Examples: ${issue.examples.slice(0, 3).join(', ')}`
        : undefined,
    }));
    return Promise.resolve(findings);
  }

  // ── Pass 5: fact — DEFERRED stub (research wiring is heavy) ──

  private runFactPass(_input: RevisionAnalyzeInput): Promise<Finding[]> {
    // TODO: wire a fact-check pass. It would extract checkable claims from the
    // chapter (dates, real-world facts, named references) and verify each via
    // the ResearchLookupService (Perplexity/OpenRouter). That research wiring —
    // rate limits, source citation, caching, and an AI extraction step — is
    // heavy enough to warrant its own change, so this pass is a documented
    // no-op stub for now. It is registered so `passes:['fact']` is a valid
    // request and future wiring is a drop-in. Reports as skipped.
    return Promise.resolve(SKIP);
  }

  // ── Aggregation helpers ──

  /** Resolve which passes to run. Unknown names are ignored; omitting the
   *  filter runs every registered pass. */
  private resolveRequestedPasses(passes?: string[]): Set<string> {
    if (!passes || passes.length === 0) return new Set(REVISION_PASSES);
    const wanted = new Set<string>();
    for (const name of passes) {
      if ((REVISION_PASSES as readonly string[]).includes(name)) wanted.add(name);
    }
    return wanted;
  }

  /**
   * De-duplicate findings. Two findings are duplicates when they share the
   * same category + location AND have a "similar" description (normalized:
   * lowercased, whitespace-collapsed, trimmed of trailing punctuation, and
   * with the leading numeric count stripped so "3 adverbs" == "5 adverbs").
   * The first occurrence (which, post-sort-input, is arbitrary) is kept.
   */
  private dedupe(findings: Finding[]): Finding[] {
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const f of findings) {
      const key = `${f.category}|${f.location ?? ''}|${this.normalizeDescription(f.description)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  private normalizeDescription(desc: string): string {
    return (desc || '')
      .toLowerCase()
      .replace(/\d+(?:\.\d+)?/g, '#') // collapse numbers so counts/rates don't defeat dedupe
      .replace(/\s+/g, ' ')
      .replace(/[.!?,;:]+$/g, '')
      .trim();
  }

  /**
   * Sort by severity (error > warning > info), then by pass order (the
   * canonical REVISION_PASSES ordering), so the most urgent, most structural
   * findings surface first.
   */
  private sort(findings: Finding[]): Finding[] {
    const passOrder = new Map<string, number>(
      REVISION_PASSES.map((p, i) => [p, i]),
    );
    return [...findings].sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      const pa = passOrder.get(a.pass) ?? 999;
      const pb = passOrder.get(b.pass) ?? 999;
      return pa - pb;
    });
  }
}

/**
 * Sentinel a pass returns to signal "not applicable — skip me" (as opposed to
 * "ran and found nothing", which returns []). Typed as Finding[] so runners can
 * return it directly; identity-compared in analyze().
 */
const SKIP = [] as unknown as Finding[] & { __skip: true };
