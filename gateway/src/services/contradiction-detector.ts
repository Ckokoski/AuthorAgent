/**
 * AuthorAgent Contradiction Detector
 *
 * ACTIVE CONTRADICTION DETECTION — a ConStory-style consistency checker that
 * diffs a single chapter against the project's persisted entity DB and the
 * prior chapter summaries, then returns CATEGORIZED, EVIDENCE-CHAINED
 * contradiction findings.
 *
 * Why this over the existing multi-phase runContinuityCheck?
 *   - runContinuityCheck audits the *whole* entity index in aggregate (three
 *     broad passes: character / timeline / settings). It answers "is the story
 *     bible internally consistent?" It does NOT take a fresh chapter of prose
 *     and diff it against what's already known.
 *   - This detector is chapter-scoped and prose-first: given the actual text of
 *     a chapter, it extracts that chapter's factual CLAIMS about known entities
 *     and pairwise-compares each claim against the entity DB attributes +
 *     change-log + prior summaries, surfacing conflicts with the ACTUAL
 *     conflicting quotes as evidence (evidence-chained, not a vague flag).
 *   - It uses a proper narrative-bug TAXONOMY (5 categories × subtypes) drawn
 *     from consistency-checking research (ConStory): CHARACTER, TIMELINE,
 *     WORLD_RULE, FACTUAL, STYLE.
 *
 * Research note: automated detection reliably catches far more consistency
 * bugs than human readers do — a reader tracks a handful of salient facts; a
 * detector can diff every claim against every prior fact. This is the moat.
 *
 * Cost discipline: ONE structured AI call per chapter, routed to the mid-tier
 * 'consistency' task type (reasoning-appropriate, not premium), with a bounded
 * output budget. The entropy pre-filter (below) is a documented stub that would
 * cut cost further once provider logprobs are wired.
 */

import type {
  ChapterSummary,
  EntityEntry,
  AICompleteFn,
  AISelectProviderFn,
} from './context-engine.js';

// ═══════════════════════════════════════════════════════════
// Taxonomy — 5 categories × subtypes (ConStory-derived)
// ═══════════════════════════════════════════════════════════

/**
 * The narrative-bug taxonomy. Each top-level category owns a set of subtypes.
 * Exported as a typed const so callers (and the AI prompt) share ONE canonical
 * vocabulary, and so the UI can group findings by category → subtype.
 *
 *   CHARACTER   — a character contradicts an established fact about themselves:
 *                 a trait (eye color, height), knowledge (knows something they
 *                 couldn't), a relationship (suddenly siblings), an ability
 *                 (can't swim, then swims), or a state (was wounded / dead).
 *   TIMELINE    — the chronology breaks: events out of order, an impossible
 *                 duration, or a sequence that can't have happened.
 *   WORLD_RULE  — an established rule of the world is violated: the magic
 *                 system, a setting fact, or in-world physics.
 *   FACTUAL     — a concrete detail changes: a name's spelling, a number/count,
 *                 an object's identity, or a location.
 *   STYLE       — a craft-level consistency break: point-of-view break, or a
 *                 tense shift (present ↔ past) within a scope that should be
 *                 uniform.
 */
export const CONTRADICTION_TAXONOMY = {
  CHARACTER: {
    label: 'Character',
    subtypes: ['trait', 'knowledge', 'relationship', 'ability', 'state'],
  },
  TIMELINE: {
    label: 'Timeline',
    subtypes: ['chronology', 'duration', 'sequence'],
  },
  WORLD_RULE: {
    label: 'World Rule',
    subtypes: ['magic-system', 'setting', 'physics'],
  },
  FACTUAL: {
    label: 'Factual',
    subtypes: ['name', 'number', 'object', 'location'],
  },
  STYLE: {
    label: 'Style',
    subtypes: ['POV-break', 'tense-shift'],
  },
} as const;

export type ContradictionCategory = keyof typeof CONTRADICTION_TAXONOMY;

/** Union of every valid subtype across all categories. */
export type ContradictionSubtype =
  (typeof CONTRADICTION_TAXONOMY)[ContradictionCategory]['subtypes'][number];

export type ContradictionSeverity = 'error' | 'warning' | 'info';

/** Set of valid category keys, for fast validation of AI output. */
const VALID_CATEGORIES = new Set<string>(Object.keys(CONTRADICTION_TAXONOMY));

/** Map of category → its allowed subtypes, for validation / snapping. */
const SUBTYPES_BY_CATEGORY: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(CONTRADICTION_TAXONOMY).map(([k, v]) => [k, v.subtypes]),
);

// ═══════════════════════════════════════════════════════════
// Result shapes
// ═══════════════════════════════════════════════════════════

/**
 * A single evidence-chained contradiction. `chapterEvidence` and
 * `priorEvidence` carry the ACTUAL conflicting quotes/facts — the point of
 * this detector is that a finding is defensible: you can see both sides of the
 * conflict, not just a vague "something's inconsistent".
 */
export interface Contradiction {
  category: ContradictionCategory;
  subtype: ContradictionSubtype;
  severity: ContradictionSeverity;
  /** Plain-language statement of what conflicts with what. */
  description: string;
  /** The claim as it appears in THIS chapter (quote or paraphrase of fact). */
  chapterEvidence: string;
  /** The conflicting established fact — from the entity DB, change-log, or a
   *  prior chapter summary. */
  priorEvidence: string;
  /** The entity this contradiction is about, when it is entity-scoped. */
  entity?: string;
  /** How to resolve it (which side to keep / what to reconcile). */
  suggestion: string;
}

export interface ContradictionReport {
  projectId: string;
  chapterId?: string;
  generatedAt: string;
  total: number;
  /** Count per taxonomy category (only categories with ≥1 finding appear). */
  byCategory: Record<string, number>;
  /** Count per severity. */
  bySeverity: Record<ContradictionSeverity, number>;
  contradictions: Contradiction[];
}

export interface DetectInput {
  projectId: string;
  chapterText: string;
  chapterId?: string;
  /** Prior chapter summaries to diff against (chapter-sorted). Optional — an
   *  empty list simply means there's no prior-narrative context to compare to. */
  priorSummaries?: ChapterSummary[];
  /** The project's entity DB to diff against. Optional — with no entities the
   *  detector still runs but has fewer anchors, so it leans on style/timeline
   *  self-consistency within the chapter. */
  entities?: EntityEntry[];
}

// ═══════════════════════════════════════════════════════════
// AI prompt
// ═══════════════════════════════════════════════════════════

const DETECT_SYSTEM_PROMPT = `You are a continuity editor running ACTIVE CONTRADICTION DETECTION on a single chapter of a novel.

You are given: (1) the chapter's prose, (2) the ESTABLISHED FACTS about known entities (attributes + a change-log of how facts changed over prior chapters), and (3) summaries of the PRIOR chapters.

Your job: find places where a factual CLAIM in THIS chapter contradicts an established fact or the prior narrative. Work claim-by-claim and evidence-chained — every finding must cite BOTH the conflicting detail in this chapter AND the established fact it conflicts with.

Use this exact taxonomy. category MUST be one of:
- CHARACTER  (subtypes: trait, knowledge, relationship, ability, state)
- TIMELINE   (subtypes: chronology, duration, sequence)
- WORLD_RULE (subtypes: magic-system, setting, physics)
- FACTUAL    (subtypes: name, number, object, location)
- STYLE      (subtypes: POV-break, tense-shift)

Rules:
- Only report REAL contradictions, not new information. A brand-new fact not stated before is NOT a contradiction. A fact that changed via the change-log ON PURPOSE (e.g. a character was injured) is NOT a contradiction — the change-log explains it.
- severity: "error" = definite contradiction; "warning" = likely; "info" = worth a look.
- chapterEvidence: the quote/fact from THIS chapter. priorEvidence: the conflicting established fact.
- entity: the entity name it concerns, when applicable.
- Be conservative. If nothing genuinely conflicts, return an empty list.

Return ONLY valid JSON. No markdown code fences. No commentary. Close every brace and bracket.
Shape:
{"contradictions":[{"category":"CHARACTER","subtype":"trait","severity":"error","description":"...","chapterEvidence":"...","priorEvidence":"...","entity":"...","suggestion":"..."}]}
If none: {"contradictions":[]}`;

// ═══════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════

export class ContradictionDetector {
  /**
   * Diff a chapter against the entity DB + prior summaries and return
   * categorized, evidence-chained contradictions.
   *
   * Never throws on AI trouble: an empty, malformed, or unparseable AI response
   * yields an empty report rather than propagating an error, so a bad model
   * turn can't break the caller's pass. (A genuinely thrown AI transport error
   * still propagates — the caller decides how to treat provider outages.)
   */
  async detect(
    input: DetectInput,
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<ContradictionReport> {
    const entities = input.entities ?? [];
    const priorSummaries = input.priorSummaries ?? [];

    // ── (a) Build the "established facts" packet the model diffs against ──
    // We reuse the ContextEngine entity shape directly (attributes + change-log)
    // and the ChapterSummary shape — this IS the entity extraction the engine
    // already did, so we don't re-extract; we feed the canonical index in.
    const entityFacts = this.buildEntityFacts(entities);
    const priorContext = this.buildPriorContext(priorSummaries);

    // Route to the mid-tier 'consistency' task type. This is the reasoning-
    // appropriate tier (same as book_bible), NOT premium — cost-aware by design.
    const provider = aiSelectProvider('consistency');

    const userContent = [
      '=== ESTABLISHED FACTS (entity DB: attributes + change-log) ===',
      entityFacts || '(no entities cached — diff on internal + timeline consistency only)',
      '',
      '=== PRIOR CHAPTER SUMMARIES ===',
      priorContext || '(no prior chapters)',
      '',
      '=== CHAPTER UNDER REVIEW ===',
      input.chapterText || '(empty chapter)',
    ].join('\n');

    let raw = '';
    try {
      const response = await aiComplete({
        provider: provider.id,
        system: DETECT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        // Bounded output — a chapter's contradiction list is short. 4096 leaves
        // headroom for a handful of evidence-quoted findings without bloating cost.
        maxTokens: 4096,
        temperature: 0.2,
      });
      raw = response?.text ?? '';
    } catch (err) {
      // Provider transport error — re-throw so the caller can record the pass
      // as skipped (matches how the orchestrator isolates a throwing pass).
      throw err;
    }

    // ── (b)+(c) Parse robustly, normalize into typed Contradictions ──
    const contradictions = this.parseContradictions(raw);
    return this.buildReport(input, contradictions);
  }

  // ── Established-facts packet ──────────────────────────────

  /**
   * Serialize the entity DB into a compact facts block the model diffs against.
   * Includes attributes AND the change-log so the model can tell an intentional
   * change (explained by the log) from a genuine contradiction.
   */
  private buildEntityFacts(entities: EntityEntry[]): string {
    if (!entities.length) return '';
    return entities
      .map((e) => {
        const attrs = Object.entries(e.attributes ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        const aliases = e.aliases?.length ? ` (aka ${e.aliases.join(', ')})` : '';
        const changeLog = (e.changes ?? [])
          .map((c) => `      • [${c.chapterId}] ${c.description}`)
          .join('\n');
        const lines = [
          `- ${e.name}${aliases} [${e.type}]: ${e.description}`,
          attrs ? `    attributes: ${attrs}` : '',
          changeLog ? `    change-log:\n${changeLog}` : '',
        ].filter(Boolean);
        return lines.join('\n');
      })
      .join('\n');
  }

  /**
   * Serialize the prior chapter summaries into a compact narrative-so-far block.
   */
  private buildPriorContext(summaries: ChapterSummary[]): string {
    if (!summaries.length) return '';
    return summaries
      .map((s) => {
        const chars = s.characters?.length ? ` | characters: ${s.characters.join(', ')}` : '';
        const time = s.timelineMarker ? ` | when: ${s.timelineMarker}` : '';
        return `- Ch ${s.chapterNumber} "${s.title}"${time}${chars}\n    ${s.summary}\n    ends: ${s.endingState}`;
      })
      .join('\n');
  }

  // ── Report assembly ───────────────────────────────────────

  private buildReport(input: DetectInput, contradictions: Contradiction[]): ContradictionReport {
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<ContradictionSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const c of contradictions) {
      byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
      bySeverity[c.severity]++;
    }
    return {
      projectId: input.projectId,
      chapterId: input.chapterId,
      generatedAt: new Date().toISOString(),
      total: contradictions.length,
      byCategory,
      bySeverity,
      contradictions,
    };
  }

  // ── AI output parsing → typed Contradictions ──────────────

  /**
   * Parse the model's JSON and coerce each entry into a well-typed
   * Contradiction. Invalid entries (bad category/subtype/severity, missing
   * evidence) are snapped to sane defaults or dropped rather than trusted
   * blindly. NEVER throws — a malformed/empty response yields [].
   */
  private parseContradictions(text: string): Contradiction[] {
    const parsed = this.safeParseJson(text);
    if (!parsed) return [];

    const rawList = Array.isArray(parsed?.contradictions)
      ? parsed.contradictions
      : Array.isArray(parsed)
        ? parsed
        : [];

    const out: Contradiction[] = [];
    for (const item of rawList) {
      const norm = this.normalizeContradiction(item);
      if (norm) out.push(norm);
    }
    return out;
  }

  /**
   * Coerce one raw object into a Contradiction, or return null to drop it.
   * A finding with no evidence on EITHER side isn't evidence-chained, so it's
   * dropped — this detector's whole value proposition is defensible findings.
   */
  private normalizeContradiction(item: any): Contradiction | null {
    if (!item || typeof item !== 'object') return null;

    const rawCategory = String(item.category ?? '').toUpperCase().trim();
    const category = (VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'FACTUAL') as ContradictionCategory;

    // Snap subtype to a valid one for the (possibly corrected) category.
    const allowed = SUBTYPES_BY_CATEGORY[category] ?? [];
    const rawSubtype = String(item.subtype ?? '').trim();
    const subtype = (allowed.includes(rawSubtype) ? rawSubtype : allowed[0]) as ContradictionSubtype;

    const sev = String(item.severity ?? '').toLowerCase().trim();
    const severity: ContradictionSeverity =
      sev === 'error' || sev === 'warning' || sev === 'info' ? sev : 'warning';

    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const chapterEvidence = typeof item.chapterEvidence === 'string' ? item.chapterEvidence.trim() : '';
    const priorEvidence = typeof item.priorEvidence === 'string' ? item.priorEvidence.trim() : '';
    const entity =
      typeof item.entity === 'string' && item.entity.trim() ? item.entity.trim() : undefined;
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';

    // Must have SOME description and at least one side of evidence, else it's
    // not a usable, defensible finding.
    if (!description && !chapterEvidence && !priorEvidence) return null;
    if (!chapterEvidence && !priorEvidence) return null;

    return {
      category,
      subtype,
      severity,
      description,
      chapterEvidence,
      priorEvidence,
      entity,
      suggestion,
    };
  }

  /**
   * Robust JSON recovery, mirroring ContextEngine.parseAIJson's strategy
   * (fences → first-brace/last-brace slice → common-fix pass → truncation
   * recovery). ContextEngine.parseAIJson is a private method and not exported,
   * so this is a local, self-contained copy tuned to never throw — it returns
   * null on total failure instead.
   */
  private safeParseJson(text: string): any | null {
    if (!text || !text.trim()) return null;

    // Strip markdown code fences some models add despite instructions.
    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    // Prefer whichever structural opener comes first.
    const open =
      start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
    if (open < 0) return null;

    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);

    // Stage 1: well-formed slice.
    if (end > open) {
      const candidate = cleaned.substring(open, end + 1);
      const p = this.tryParse(candidate);
      if (p !== undefined) return p;
    }

    // Stage 2: truncation recovery — close open containers in reverse order.
    const recovered = this.recoverTruncatedJson(cleaned.substring(open));
    if (recovered) {
      const p = this.tryParse(recovered);
      if (p !== undefined) return p;
    }

    return null;
  }

  /** JSON.parse with a couple of common-fix passes. undefined on failure. */
  private tryParse(candidate: string): any | undefined {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
    try {
      const fixed = candidate
        .replace(/,\s*([}\]])/g, '$1') // trailing commas
        .replace(/:\s*'([^']*)'/g, ': "$1"'); // single → double quotes on values
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort close of a truncated JSON string: walk the structure tracking
   * string context + brace/bracket depth, then append the missing closers in
   * reverse order. Salvages the common max_tokens-cut-off case where all but
   * the last finding is complete.
   */
  private recoverTruncatedJson(s: string): string | null {
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    let inString = false;
    let escape = false;
    const stack: string[] = [];
    let lastSafeComma = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
      else if (c === ',' && stack.length >= 1 && stack[stack.length - 1] === '[') {
        // A comma directly inside an array separates complete elements — a
        // safe truncation point that keeps every prior element intact.
        lastSafeComma = i;
      }
    }
    if (stack.length === 0 && !inString) return s;

    // Trim to the last complete array element, then reclose.
    let truncated = s;
    if (lastSafeComma > 0) {
      truncated = s.substring(0, lastSafeComma);
      const newStack: string[] = [];
      let inStr = false;
      let esc = false;
      for (const c of truncated) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') newStack.push(c);
        else if (c === '}' || c === ']') newStack.pop();
      }
      while (newStack.length > 0) {
        const openCh = newStack.pop()!;
        truncated += openCh === '{' ? '}' : ']';
      }
      return truncated;
    }

    // Fallback: close whatever's open (may still be malformed if cut mid-string).
    let recovery = s;
    if (inString) recovery += '"';
    while (stack.length > 0) {
      const openCh = stack.pop()!;
      recovery += openCh === '{' ? '}' : ']';
    }
    return recovery;
  }

  // ═══════════════════════════════════════════════════════════
  // ENTROPY PRE-FILTER — DOCUMENTED STUB (deferred: needs logprobs)
  // ═══════════════════════════════════════════════════════════

  /**
   * Flag high-entropy paragraph spans that are the most likely to hide a
   * contradiction, so the expensive whole-chapter detect() call can be
   * pre-filtered down to just the suspicious spans.
   *
   * THE IDEA (why entropy correlates with contradiction risk):
   *   When a model wrote a passage, the tokens where it was LEAST certain —
   *   high per-token entropy / low logprob — are exactly the spans where it was
   *   improvising facts rather than recalling established ones. Those improvised
   *   facts are the ones most likely to contradict the entity DB. Ranking spans
   *   by mean token entropy therefore concentrates the check on the risky 20%
   *   of the chapter, cutting the detection cost without losing coverage.
   *
   * WHY THIS IS INERT TODAY:
   *   It needs PER-TOKEN LOGPROBS for the chapter text. Our AIRouter.complete
   *   path does not surface logprobs:
   *     - OpenAI's Chat Completions API *does* support `logprobs`/`top_logprobs`,
   *       so this could be wired for the OpenAI provider.
   *     - Gemini and Claude (as we call them today) do NOT expose per-token
   *       logprobs through our request path.
   *   Until AIRouter is extended to request + return logprobs, this method has
   *   no data to score, so it is a NO-OP that returns the full paragraph set
   *   unchanged (i.e. "check everything"). It is deliberately NOT faked with a
   *   heuristic — a fake entropy score would silently skip real paragraphs.
   *
   * Interface contract (so wiring later is a drop-in):
   *   @param paragraphs  the chapter split into paragraph spans (text + offset).
   *   @param tokenLogprobs  optional aligned per-token logprobs for the chapter.
   *                         When absent (today, always), every paragraph is
   *                         returned — nothing is pre-filtered out.
   *   @param options.topFraction  keep the top fraction of paragraphs by entropy
   *                               (default 1.0 = keep all).
   *   @returns the subset of paragraph indices to send to detect(). Today: all.
   */
  entropyPreFilter(
    paragraphs: Array<{ index: number; text: string; offset: number }>,
    tokenLogprobs?: Array<{ token: string; logprob: number; offset: number }>,
    options?: { topFraction?: number },
  ): number[] {
    // No logprobs available through our current provider calls → cannot score
    // entropy → do not pre-filter. Return every paragraph index unchanged.
    if (!tokenLogprobs || tokenLogprobs.length === 0) {
      return paragraphs.map((p) => p.index);
    }

    // ---- The following path is UNREACHABLE until logprobs are wired. It is
    // ---- kept as the concrete implementation the drop-in would use, so the
    // ---- interface is real and testable once data exists. ----
    const scored = paragraphs.map((p) => {
      const start = p.offset;
      const endOff = start + p.text.length;
      const inSpan = tokenLogprobs.filter((t) => t.offset >= start && t.offset < endOff);
      // Mean surprisal (−logprob) over the paragraph's tokens. Higher = the
      // model was less certain here = higher contradiction risk.
      const meanSurprisal = inSpan.length
        ? inSpan.reduce((sum, t) => sum + -t.logprob, 0) / inSpan.length
        : 0;
      return { index: p.index, score: meanSurprisal };
    });

    const topFraction = options?.topFraction ?? 1.0;
    if (topFraction >= 1.0) return scored.map((s) => s.index);

    const keep = Math.max(1, Math.ceil(scored.length * topFraction));
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
      .map((s) => s.index)
      .sort((a, b) => a - b);
  }
}
