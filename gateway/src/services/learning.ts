/**
 * AuthorClaw Learning Service — the LEARN-FROM-EXPERIENCE loop.
 *
 * The quality tools (revision orchestrator, contradiction detector, character
 * persona agents) each produce a fresh report per chapter. Individually those
 * reports are ephemeral: you fix the flagged lines and move on. The MOAT is
 * turning the RECURRING flags across many reports into durable, reusable
 * LESSONS that feed back into future writing — so the agent stops making the
 * same mistake twice.
 *
 * How the loop closes (this is the whole point):
 *   1. LearningService aggregates findings across the given reports with cheap
 *      CODE (group by category / pass / character / severity, count).
 *   2. It distils the top recurring patterns into concise, actionable lesson
 *      text — ONE optional free-tier ('general') AI call to phrase them well,
 *      with a deterministic fallback so it works with no API keys.
 *   3. It writes each lesson to the LessonStore (dedup-aware: a lesson already
 *      known gets its confidence bumped, not re-added).
 *   4. LessonStore.buildContext() already injects high-confidence lessons into
 *      the writing system prompt (message-pipeline.ts buildSystemPrompt →
 *      "# Lessons Learned"). So the moment a lesson lands in the store, the
 *      next write/revision sees it. The loop closes automatically.
 *
 * ─── What this REUSES (does not rebuild) ───────────────────────────────────
 *   • lessons.ts (LessonStore) — durable JSONL store + confidence + prompt
 *     injection. We only ADD to it via addLesson/adjustConfidence.
 *   • revision-orchestrator.ts (RevisionReport / Finding) — pass + category +
 *     severity are exactly the axes we group on.
 *   • contradiction-detector.ts (ContradictionReport / Contradiction) — the
 *     taxonomy category + entity give us "repeated timeline breaks" / "watch
 *     Character X" patterns.
 *   • character-agent.ts (CharacterCritiqueReport / CharacterFlag) — per-
 *     character off-voice / anachronism / off-motivation repetition.
 *   • router.ts TASK_TIERS — 'general' is FREE; the pattern-phrasing call uses
 *     it so distillation never burns a premium token.
 *
 * ─── Cost discipline ───────────────────────────────────────────────────────
 * Aggregation is pure CODE (no AI). AT MOST ONE free-tier AI call phrases the
 * top-N patterns. If no aiComplete is wired (or it fails/returns junk), we emit
 * deterministic lesson text straight from the counts. Never throws.
 */

import type { RevisionReport, Finding } from './revision-orchestrator.js';
import type { ContradictionReport, Contradiction } from './contradiction-detector.js';
import type { CharacterCritiqueReport } from './character-agent.js';
import type { LessonStore, Lesson } from './lessons.js';
import type { AICompleteFn, AISelectProviderFn } from './context-engine.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type LearnReportType = 'revision' | 'contradiction' | 'character';

/** One report handed to the learner, tagged with which tool produced it. */
export interface LearnReportInput {
  type: LearnReportType;
  report: RevisionReport | ContradictionReport | CharacterCritiqueReport | any;
}

export interface LearnFromReportsInput {
  projectId?: string;
  reports: LearnReportInput[];
}

/** A recurring pattern detected by CODE aggregation across the reports. */
export interface DetectedPattern {
  /** Stable key identifying this pattern (e.g. 'revision:anti-slop/adverbs'). */
  key: string;
  /** Which tool family this pattern came from. */
  kind: LearnReportType;
  /** The grouping axis value (a pass/category, taxonomy category, or a
   *  character name + issue). */
  label: string;
  /** How many findings across all reports rolled up into this pattern. */
  count: number;
  /** Worst severity seen for this pattern ('error' > 'warning' > 'info'). */
  severity: 'error' | 'warning' | 'info';
  /** The LessonStore category this pattern maps to (writing_quality, etc). */
  lessonCategory: string;
  /** A short human-readable sample description (first finding), for context. */
  sample?: string;
}

/** A lesson that was written (or bumped) as a result of learning. */
export interface LearnedLesson {
  text: string;
  /** The provenance tag we intended (e.g. 'learned:revision'). The underlying
   *  store coerces `source` to its own vocabulary; this preserves intent. */
  source: string;
  confidence: number;
  /** true when this bumped an existing lesson's confidence instead of adding. */
  bumped?: boolean;
}

export interface LearnOutcome {
  projectId?: string;
  generatedAt: string;
  /** Every recurring pattern the aggregation surfaced (before the top-N cut). */
  patternsFound: DetectedPattern[];
  /** Lessons newly written to the store. */
  lessonsAdded: LearnedLesson[];
  /** Lessons that matched an existing lesson (confidence bumped, not re-added). */
  lessonsSkippedDuplicate: LearnedLesson[];
  /** One-line human summary of what happened. */
  summary: string;
}

// ═══════════════════════════════════════════════════════════
// Tuning
// ═══════════════════════════════════════════════════════════

/** A pattern must recur at least this many times to become a lesson. A single
 *  one-off flag is noise, not a durable lesson. */
const MIN_PATTERN_COUNT = 2;
/** Cap how many patterns we distil into lessons per run — the loudest signals
 *  first, so the lesson store stays high-signal and the AI call stays cheap. */
const TOP_N_PATTERNS = 6;
/** Base confidence for a freshly-learned lesson. Deliberately mid — a learned
 *  lesson is a hypothesis; it earns confidence as it recurs / gets accepted. */
const BASE_CONFIDENCE = 0.5;
/** Confidence bump applied when a pattern re-appears (dedup path). */
const DEDUP_BUMP = 0.05;
/** Ceiling for the recurrence-weighted base confidence. */
const MAX_LEARNED_CONFIDENCE = 0.75;

const SEVERITY_RANK: Record<'error' | 'warning' | 'info', number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ═══════════════════════════════════════════════════════════
// AI prompt (optional, free-tier phrasing pass)
// ═══════════════════════════════════════════════════════════

const DISTILL_SYSTEM_PROMPT = `You are a writing coach turning recurring editing-tool flags into DURABLE, REUSABLE lessons for an AI writing agent to apply BEFORE it writes, so it stops repeating the same mistakes.

You are given a list of PATTERNS. Each pattern has: a label (what the flag is about), a count (how many times it was flagged), a worst severity, and a sample flag. Write ONE lesson per pattern.

A good lesson is:
- ACTIONABLE and forward-looking — phrased as guidance for the NEXT draft ("Prefer strong verbs over -ly adverbs"), not a report of the past.
- SPECIFIC to the pattern, not generic.
- SHORT — one sentence, ideally under 20 words. You MAY end with the frequency in parentheses (e.g. "(flagged 14x)").
- Free of manuscript spoilers — reference the CRAFT issue, not plot details.

Return ONLY valid JSON. No markdown fences, no commentary. Close every brace and bracket.
Shape: {"lessons":[{"key":"<the pattern key, copied exactly>","lesson":"<the lesson text>"}]}
Include one entry per input pattern, each with the pattern's exact key.`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class LearningService {
  private lessons: LessonStore;

  /**
   * @param lessons the durable LessonStore this learner writes into. Required —
   *   without a store there is nowhere to close the loop, and the routes 503
   *   before constructing the service.
   */
  constructor(lessons: LessonStore) {
    this.lessons = lessons;
  }

  /**
   * Aggregate findings across the given quality reports, distil the recurring
   * patterns into lessons, and write them into the LessonStore (dedup-aware).
   *
   * NEVER throws. Empty/malformed reports yield an empty-but-well-formed
   * outcome. A failing AI call falls back to deterministic lesson text. A
   * failing store write is swallowed (the pattern is simply not recorded).
   */
  async learnFromReports(
    input: LearnFromReportsInput,
    aiComplete?: AICompleteFn | null,
    aiSelectProvider?: AISelectProviderFn | null,
  ): Promise<LearnOutcome> {
    const generatedAt = new Date().toISOString();
    const projectId = input?.projectId;

    // ── (a) CODE aggregation → recurring patterns (no AI) ──
    const patterns = this.detectPatterns(input?.reports ?? []);

    // Only patterns that RECUR are lesson-worthy. Sort by severity then count so
    // the loudest, most-severe signals distil first; cap at TOP_N.
    const recurring = patterns
      .filter((p) => p.count >= MIN_PATTERN_COUNT)
      .sort((a, b) => {
        const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (sev !== 0) return sev;
        return b.count - a.count;
      })
      .slice(0, TOP_N_PATTERNS);

    // ── (b) Phrase the patterns as lessons — ONE free-tier call, else code ──
    const phrased = await this.phrasePatterns(recurring, aiComplete, aiSelectProvider);

    // ── (c) Write to the LessonStore, dedup-aware ──
    const lessonsAdded: LearnedLesson[] = [];
    const lessonsSkippedDuplicate: LearnedLesson[] = [];

    for (const pattern of recurring) {
      const phrasedText = phrased.get(pattern.key) ?? this.deterministicLesson(pattern);
      const source = `learned:${pattern.kind}`;
      // The persisted lesson carries a stable, legible provenance tag encoding
      // the PATTERN it was learned from (e.g. "[learned:revision/anti-slop/
      // ai_tell]"). This is the dedup anchor: the AI may phrase the same pattern
      // slightly differently each run, but the tag is deterministic — so a
      // recurring pattern reliably dedupes even when the wording drifts. The tag
      // also reads as clear provenance in the injected "# Lessons Learned" block.
      const text = `${phrasedText} ${this.provenanceTag(pattern)}`;
      // Recurrence-weighted confidence: a pattern flagged many times is a
      // stronger lesson than one flagged twice. Bounded so it never starts near-certain.
      const confidence = Math.min(
        MAX_LEARNED_CONFIDENCE,
        BASE_CONFIDENCE + Math.min(0.2, (pattern.count - MIN_PATTERN_COUNT) * 0.02),
      );

      const existing = this.findDuplicate(pattern, text);
      if (existing) {
        // DEDUP: don't re-add. Bump the known lesson's confidence instead — it
        // just recurred, so we trust it a little more.
        const bumped = await this.safeBump(existing.id, DEDUP_BUMP);
        lessonsSkippedDuplicate.push({
          text,
          source,
          confidence: bumped?.confidence ?? existing.confidence,
          bumped: true,
        });
        continue;
      }

      const written = await this.safeAdd({
        timestamp: generatedAt,
        // 'self-critique' is the closest VALID LessonStore source for "the agent
        // learned this from its own quality tools". The store coerces unknown
        // sources anyway; the fine-grained provenance ('learned:revision') is
        // preserved in the returned outcome's `source` and the lesson's tag.
        category: pattern.lessonCategory,
        lesson: text,
        source: 'self-critique',
        confidence,
        goalId: projectId,
      });

      if (written) {
        lessonsAdded.push({ text, source, confidence: written.confidence });
      }
      // If the write failed, we simply don't report it — never throw.
    }

    const summary = this.buildSummary(patterns.length, recurring.length, lessonsAdded.length, lessonsSkippedDuplicate.length);

    return {
      projectId,
      generatedAt,
      patternsFound: patterns,
      lessonsAdded,
      lessonsSkippedDuplicate,
      summary,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // (a) Pattern detection — pure CODE aggregation
  // ═══════════════════════════════════════════════════════════

  /**
   * Roll every finding across every report up into recurring patterns. Each
   * report type contributes its own natural grouping axis:
   *   revision      → pass + category   (e.g. "anti-slop/ai_tell")
   *   contradiction → taxonomy category (e.g. "TIMELINE") — repeated chrono breaks
   *   character     → character + issue (e.g. "Alice / off-voice")
   * A finding's worst severity wins for the pattern; counts accumulate.
   */
  detectPatterns(reports: LearnReportInput[]): DetectedPattern[] {
    const map = new Map<string, DetectedPattern>();

    for (const entry of reports ?? []) {
      if (!entry || typeof entry !== 'object' || !entry.report) continue;
      try {
        switch (entry.type) {
          case 'revision':
            this.foldRevision(entry.report as RevisionReport, map);
            break;
          case 'contradiction':
            this.foldContradiction(entry.report as ContradictionReport, map);
            break;
          case 'character':
            this.foldCharacter(entry.report as CharacterCritiqueReport, map);
            break;
          default:
            // Unknown report type — ignore rather than throw.
            break;
        }
      } catch {
        // A single malformed report must never sink the aggregation.
      }
    }

    return Array.from(map.values());
  }

  private foldRevision(report: RevisionReport, map: Map<string, DetectedPattern>): void {
    const findings: Finding[] = Array.isArray(report?.findings) ? report.findings : [];
    for (const f of findings) {
      if (!f || typeof f !== 'object') continue;
      const pass = String(f.pass ?? 'revision').trim() || 'revision';
      const category = String(f.category ?? 'general').trim() || 'general';
      const label = `${pass}/${category}`;
      const key = `revision:${label}`;
      this.bumpPattern(map, {
        key,
        kind: 'revision',
        label,
        severity: this.normSeverity(f.severity),
        lessonCategory: this.mapRevisionCategory(pass, category),
        sample: typeof f.description === 'string' ? f.description : undefined,
      });
    }
  }

  private foldContradiction(report: ContradictionReport, map: Map<string, DetectedPattern>): void {
    const list: Contradiction[] = Array.isArray(report?.contradictions) ? report.contradictions : [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const category = String(c.category ?? 'FACTUAL').trim() || 'FACTUAL';
      // Group by taxonomy category (repeated TIMELINE breaks, etc). The entity,
      // when present, sharpens the sample but not the grouping — we want the
      // "watch chronology" lesson, not one lesson per entity.
      const label = category;
      const key = `contradiction:${label}`;
      const sampleParts = [c.description, c.entity ? `(re: ${c.entity})` : ''].filter(Boolean);
      this.bumpPattern(map, {
        key,
        kind: 'contradiction',
        label,
        severity: this.normSeverity(c.severity),
        lessonCategory: 'writing_quality',
        sample: sampleParts.join(' ') || undefined,
      });
    }
  }

  private foldCharacter(report: CharacterCritiqueReport, map: Map<string, DetectedPattern>): void {
    const byCharacter = Array.isArray(report?.byCharacter) ? report.byCharacter : [];
    for (const block of byCharacter) {
      if (!block || typeof block !== 'object') continue;
      const character = String(block.character ?? 'a character').trim() || 'a character';
      const flags = Array.isArray(block.flags) ? block.flags : [];
      for (const flag of flags) {
        if (!flag || typeof flag !== 'object') continue;
        const issue = String(flag.issue ?? 'off-voice').trim() || 'off-voice';
        const label = `${character} / ${issue}`;
        const key = `character:${character.toLowerCase()}::${issue}`;
        this.bumpPattern(map, {
          key,
          kind: 'character',
          label,
          // Character flags are voice/consistency signals — no severity field on
          // the flag, so treat as 'warning' (a soft, correctable signal).
          severity: 'warning',
          lessonCategory: issue === 'off-voice' ? 'style_voice' : 'writing_quality',
          sample: typeof flag.reason === 'string' ? flag.reason : undefined,
        });
      }
    }
  }

  /** Insert-or-accumulate one pattern occurrence into the rollup map. */
  private bumpPattern(
    map: Map<string, DetectedPattern>,
    seed: Omit<DetectedPattern, 'count'> & { count?: number },
  ): void {
    const existing = map.get(seed.key);
    if (!existing) {
      map.set(seed.key, {
        key: seed.key,
        kind: seed.kind,
        label: seed.label,
        count: seed.count ?? 1,
        severity: seed.severity,
        lessonCategory: seed.lessonCategory,
        sample: seed.sample,
      });
      return;
    }
    existing.count += seed.count ?? 1;
    // Keep the worst severity seen.
    if (SEVERITY_RANK[seed.severity] < SEVERITY_RANK[existing.severity]) {
      existing.severity = seed.severity;
    }
    // Keep the first non-empty sample.
    if (!existing.sample && seed.sample) existing.sample = seed.sample;
  }

  private normSeverity(sev: any): 'error' | 'warning' | 'info' {
    const s = String(sev ?? '').toLowerCase().trim();
    return s === 'error' || s === 'warning' || s === 'info' ? s : 'warning';
  }

  /**
   * Map a revision (pass, category) to a LessonStore category. anti-slop / craft
   * are writing-quality craft issues; voice is style; continuity is quality.
   */
  private mapRevisionCategory(pass: string, category: string): string {
    if (pass === 'voice') return 'style_voice';
    const c = category.toLowerCase();
    if (c.includes('voice') || c.includes('style')) return 'style_voice';
    return 'writing_quality';
  }

  // ═══════════════════════════════════════════════════════════
  // (b) Phrasing — ONE optional free-tier call, deterministic fallback
  // ═══════════════════════════════════════════════════════════

  /**
   * Phrase the recurring patterns as lesson text. Returns a map key→lesson.
   * Attempts ONE free-tier AI call for polished phrasing; on any trouble (no
   * AI wired, transport error, malformed output) returns an EMPTY map and the
   * caller falls back to deterministicLesson() per pattern.
   */
  private async phrasePatterns(
    patterns: DetectedPattern[],
    aiComplete?: AICompleteFn | null,
    aiSelectProvider?: AISelectProviderFn | null,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (patterns.length === 0) return out;
    if (!aiComplete || !aiSelectProvider) return out; // no AI → deterministic fallback

    let providerId: string;
    try {
      // FREE tier — pattern phrasing is cheap language work, never premium.
      providerId = aiSelectProvider('general').id;
    } catch {
      return out;
    }

    const userContent = [
      'PATTERNS (one lesson each, keep the exact key):',
      JSON.stringify(
        patterns.map((p) => ({
          key: p.key,
          label: p.label,
          count: p.count,
          severity: p.severity,
          sample: (p.sample || '').slice(0, 240),
        })),
        null,
        2,
      ),
    ].join('\n');

    let raw = '';
    try {
      const response = await aiComplete({
        provider: providerId,
        system: DISTILL_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        // A handful of one-sentence lessons is short. 1024 is ample.
        maxTokens: 1024,
        temperature: 0.3,
      });
      raw = response?.text ?? '';
    } catch {
      // Transport/AI failure → deterministic fallback (do NOT throw).
      return out;
    }

    const parsed = this.safeParseJson(raw);
    const list = Array.isArray(parsed?.lessons)
      ? parsed.lessons
      : Array.isArray(parsed)
        ? parsed
        : [];
    const validKeys = new Set(patterns.map((p) => p.key));
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = typeof item.key === 'string' ? item.key.trim() : '';
      const lesson = typeof item.lesson === 'string' ? item.lesson.trim() : '';
      if (!key || !lesson || !validKeys.has(key)) continue;
      out.set(key, this.clampLessonText(lesson));
    }
    return out;
  }

  /**
   * Deterministic lesson text from the counts — the guard when no AI phrased a
   * pattern. Reads like guidance, cites the frequency, and never spoils plot.
   */
  private deterministicLesson(p: DetectedPattern): string {
    const freq = `flagged ${p.count}x`;
    switch (p.kind) {
      case 'revision': {
        const [pass, category] = p.label.split('/');
        const nice = this.humanizeToken(category || pass);
        if (pass === 'anti-slop') {
          return `Avoid ${nice} — an AI-tell repeatedly caught by the anti-slop screen (${freq}).`;
        }
        if (pass === 'voice') {
          return `Hold character voice steady; ${nice} drift keeps recurring (${freq}).`;
        }
        if (pass === 'craft') {
          return `Tighten craft: ${nice} issues recur — revise for it up front (${freq}).`;
        }
        if (pass === 'continuity') {
          return `Guard continuity for ${nice}; contradictions recur across chapters (${freq}).`;
        }
        return `Watch for ${nice} (${pass}) issues — they recur (${freq}).`;
      }
      case 'contradiction': {
        const cat = p.label.toUpperCase();
        if (cat === 'TIMELINE') return `Watch chronology in multi-POV chapters — timeline contradictions recur (${freq}).`;
        if (cat === 'CHARACTER') return `Keep character facts consistent with the story bible — character contradictions recur (${freq}).`;
        if (cat === 'WORLD_RULE') return `Respect the established world rules and magic system — rule breaks recur (${freq}).`;
        if (cat === 'FACTUAL') return `Keep names, numbers, and objects consistent — factual contradictions recur (${freq}).`;
        if (cat === 'STYLE') return `Hold POV and tense uniform within a scene — style breaks recur (${freq}).`;
        return `Check ${this.humanizeToken(cat)} consistency against the story bible (${freq}).`;
      }
      case 'character': {
        const [character, issue] = p.label.split(' / ');
        const who = (character || 'a character').trim();
        if (issue === 'off-voice') return `${who} drifts off-voice under pressure — anchor to their voice fingerprint (${freq}).`;
        if (issue === 'anachronistic-knowledge') return `${who} references things they can't know yet — respect their knowledge horizon (${freq}).`;
        if (issue === 'off-motivation') return `${who}'s lines drift from their motivation — keep dialogue arc-consistent (${freq}).`;
        return `Keep ${who} in character — ${this.humanizeToken(issue || '')} recurs (${freq}).`;
      }
      default:
        return `Recurring issue: ${p.label} (${freq}).`;
    }
  }

  private humanizeToken(token: string): string {
    return String(token || '')
      .replace(/[_/-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase() || 'this issue';
  }

  private clampLessonText(text: string): string {
    // Guard against a chatty model — keep lessons one sentence-ish.
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= 200) return cleaned;
    return cleaned.slice(0, 197).trimEnd() + '…';
  }

  private buildSummary(total: number, recurring: number, added: number, bumped: number): string {
    if (total === 0) return 'No findings to learn from.';
    if (recurring === 0) return `${total} pattern(s) seen, none recurred enough to become a lesson.`;
    const parts = [`${recurring} recurring pattern(s)`];
    parts.push(`${added} new lesson(s)`);
    if (bumped > 0) parts.push(`${bumped} existing lesson(s) reinforced`);
    return `Learned ${parts.join(', ')}.`;
  }

  // ═══════════════════════════════════════════════════════════
  // (c) LessonStore writes — dedup-aware, never throw
  // ═══════════════════════════════════════════════════════════

  /**
   * A stable, legible provenance tag encoding the pattern a lesson was learned
   * from, e.g. "[learned:revision/anti-slop/ai_tell]". Deterministic per pattern
   * key, so it survives AI phrasing drift and serves as the dedup anchor.
   */
  private provenanceTag(p: DetectedPattern): string {
    // pattern.key is already "<kind>:<label-with-slashes>" — reuse it verbatim
    // so the tag is exactly as stable as the aggregation key.
    return `[learned:${p.key.replace(/^[^:]+:/, `${p.kind}/`)}]`;
  }

  /**
   * Find an existing lesson that represents the SAME learned pattern.
   * Primary anchor: the stable provenance tag (survives AI-phrasing variance
   * between runs). Fallback: normalized text equality (lowercased, whitespace-
   * collapsed, frequency-count stripped so "(flagged 12x)" == "(flagged 14x)")
   * — this also dedupes against lessons authored WITHOUT a tag (e.g. legacy /
   * hand-written ones).
   */
  private findDuplicate(pattern: DetectedPattern, text: string): Lesson | null {
    const tag = this.provenanceTag(pattern);
    const target = this.normalizeLessonText(text);
    for (const l of this.lessons.getAll()) {
      if (typeof l.lesson === 'string' && l.lesson.includes(tag)) return l;
      if (target && this.normalizeLessonText(l.lesson) === target) return l;
    }
    return null;
  }

  private normalizeLessonText(text: string): string {
    return String(text || '')
      .toLowerCase()
      .replace(/\[learned:[^\]]*\]/g, '') // strip provenance tag (dedup handles it separately)
      .replace(/\(flagged\s+\d+x\)/g, '') // frequency count shouldn't defeat dedup
      .replace(/\d+(?:\.\d+)?/g, '#') // any remaining counts → placeholder
      .replace(/\s+/g, ' ')
      .replace(/[.!?,;:]+$/g, '')
      .trim();
  }

  /** addLesson wrapper that never throws — returns null on failure. */
  private async safeAdd(input: {
    timestamp: string;
    category: string;
    lesson: string;
    source: string;
    confidence: number;
    goalId?: string;
  }): Promise<Lesson | null> {
    try {
      return await this.lessons.addLesson(input as any);
    } catch {
      return null;
    }
  }

  /** adjustConfidence wrapper that never throws — returns null on failure. */
  private async safeBump(lessonId: string, delta: number): Promise<Lesson | null> {
    try {
      return await this.lessons.adjustConfidence(lessonId, delta);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // JSON recovery (mirrors the sibling services' robust parser)
  // ═══════════════════════════════════════════════════════════

  private safeParseJson(text: string): any | null {
    if (!text || !text.trim()) return null;
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    const open = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
    if (open < 0) return null;

    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);

    if (end > open) {
      const candidate = cleaned.substring(open, end + 1);
      const p = this.tryParse(candidate);
      if (p !== undefined) return p;
    }
    // Last resort: try the whole cleaned string.
    const p = this.tryParse(cleaned);
    return p === undefined ? null : p;
  }

  private tryParse(candidate: string): any | undefined {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
    try {
      const fixed = candidate
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
}
