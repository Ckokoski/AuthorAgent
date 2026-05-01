/**
 * AuthorClaw Writing Judge
 *
 * Modify-evaluate-retry loop for chapter writing, ported from AutoNovel's
 * dual-immune-system pattern. Every chapter draft passes through:
 *
 *   1. Mechanical screen — regex-based checks for cliches, AI-tell words,
 *      adverb density, filter words, passive voice, weak verbs. Cheap,
 *      deterministic, runs locally.
 *
 *   2. LLM judge — single AI call that scores 6 craft dimensions (voice,
 *      show-vs-tell, pacing, dialogue, sensory, emotional truth) on 1-10
 *      and surfaces 1-3 specific issues per dimension.
 *
 *   3. Combined score with weighting — overall 1-10. Below threshold
 *      triggers a retry with the judge's feedback as steering input.
 *
 * Why both layers?
 *   - Mechanical screens catch formulaic patterns LLMs miss (or generate
 *     themselves — "delve", "tapestry", "testament" all rate fine in
 *     LLM judges because LLMs wrote them in the first place)
 *   - LLM judges catch coherence and voice issues mechanical screens
 *     can't see (a chapter with great word stats but a flat emotional arc)
 *
 * Cost discipline:
 *   - Mechanical screen is free (no AI call)
 *   - LLM judge: 1 call per chapter
 *   - Retry: 1 additional draft call + 1 additional judge call
 *   - Default cap: 1 retry, so each chapter costs at most 3 AI calls
 *     (1 draft + 1 judge + 1 retry-with-feedback).
 *   - User can disable retries via project config to keep cost = 2 AI calls.
 */

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface MechanicalIssue {
  category: 'cliche' | 'ai_tell' | 'filter_word' | 'adverb_density' |
            'passive_voice' | 'weak_verb' | 'banned_phrase' | 'hedge_word' |
            'started_to' | 'suddenly';
  severity: 'info' | 'warning' | 'error';
  description: string;
  examples: string[];
  count: number;
}

export interface MechanicalReport {
  wordCount: number;
  issues: MechanicalIssue[];
  /** Composite mechanical score 0-100. 100 = clean, 0 = riddled. */
  score: number;
}

export interface JudgeDimension {
  name: string;
  score: number;          // 1-10
  issues: string[];       // 1-3 specific problems
}

export type JudgeKind = 'craft' | 'market';

export interface JudgeReport {
  /** Which judge produced this report — 'craft' (developmental editor lens)
   *  or 'market' (acquiring editor + agent lens). */
  kind: JudgeKind;
  dimensions: JudgeDimension[];
  /** Average of dimension scores 1-10. */
  overall: number;
  /** Top 3 most actionable issues across all dimensions. */
  topIssues: string[];
}

/**
 * When dual-judge mode is enabled, we surface where the two judges agree
 * vs disagree. Disagreement is the most actionable signal — it usually
 * means the chapter is doing something deliberate that may or may not work.
 */
export interface DualJudgeAnalysis {
  craft: JudgeReport;
  market: JudgeReport;
  /** Average of craft + market overall scores, 0-100 scale. */
  combinedOverall100: number;
  /** Magnitude of disagreement (|craft - market| × 10). */
  disagreementGap: number;
  /** Plain-English read of the disagreement, when meaningful. */
  disagreementNote: string;
}

export interface QualityVerdict {
  /** Combined score 0-100. */
  score: number;
  /** True if the chapter should be retried. */
  retry: boolean;
  /** The mechanical screen result. */
  mechanical: MechanicalReport;
  /** The single LLM judge result. Set when single-judge mode is used. Null in dual mode. */
  judge: JudgeReport | null;
  /** Set when dual-judge mode is used. Null in single mode. */
  dualJudge: DualJudgeAnalysis | null;
  /** Human-readable summary for logs. */
  summary: string;
  /** Steering text to pass to the AI on retry. */
  retryFeedback: string;
}

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

// ═══════════════════════════════════════════════════════════
// Mechanical screen lexicons
// ═══════════════════════════════════════════════════════════

// AI-tell words — phrases that flag LLM-generated prose to readers.
const AI_TELL_PATTERNS = [
  /\bdelve(s|d|ing)? into\b/gi,
  /\btapestry of\b/gi,
  /\btestament to\b/gi,
  /\bin the realm of\b/gi,
  /\bnavigate(s|d|ing)? (?:the|this|these)\b/gi,
  /\bmultifaceted\b/gi,
  /\bmyriad of\b/gi,
  /\bnuanced\b/gi,
  /\bvisceral\b/gi,
  /\bresonate(s|d)? (?:with|deeply)\b/gi,
  /\bparadigm\b/gi,
  /\bbeacon of\b/gi,
  /\bin (?:today|this)['\s]+\w+\s+(?:landscape|world)\b/gi,
  /\bit['\s]s worth (?:noting|mentioning) that\b/gi,
  /\bunderscores? (?:the|that)\b/gi,
  /\bjourney of self.discovery\b/gi,
];

// Banned cliches — phrases that signal lazy prose.
const BANNED_PHRASES = [
  /\bat the end of the day\b/gi,
  /\btip of the iceberg\b/gi,
  /\bin the blink of an eye\b/gi,
  /\bavoid like the plague\b/gi,
  /\bbutterflies in (?:her|his|their|my) stomach\b/gi,
  /\bheart skipped a beat\b/gi,
  /\bno stone unturned\b/gi,
  /\bcalm before the storm\b/gi,
  /\bonly time will tell\b/gi,
  /\bdeafening silence\b/gi,
  /\bfor what (?:felt|seemed) like (?:hours|an eternity)\b/gi,
  /\beyes (?:bored|drilled) into\b/gi,
];

// Filter words — they put a narrator between the reader and the POV character.
const FILTER_WORDS = new Set([
  'saw', 'heard', 'felt', 'smelled', 'tasted', 'noticed', 'watched',
  'thought', 'realized', 'wondered', 'decided', 'knew', 'understood',
  'seemed', 'appeared', 'observed',
]);

// Hedge words — sap urgency when overused.
const HEDGE_WORDS = new Set([
  'perhaps', 'maybe', 'might', 'possibly', 'probably', 'apparently',
  'somewhat', 'rather', 'quite',
]);

// Passive voice: "was/were/is/are/be/been/being + past participle"
const PASSIVE_VOICE_RE = /\b(?:was|were|is|are|be|been|being)\s+\w+ed\b/gi;

// Adverb detection — word ending in "ly" excluding common false positives.
const NON_ADVERB_LY = new Set([
  'family', 'supply', 'only', 'reply', 'apply', 'holy', 'lovely', 'early',
  'ugly', 'silly', 'jolly', 'belly', 'bully', 'really',
]);

// Weak verbs that should usually be replaced with stronger ones.
const WEAK_VERBS_RE = /\b(?:was|were|had been|got|gotten|went|came|put|got)\b/gi;

// "Started to" / "began to" — usually droppable.
const STARTED_TO_RE = /\b(?:started|begun|began) to\s+\w+/gi;

// "Suddenly" — almost always cuttable.
const SUDDENLY_RE = /\bsuddenly\b/gi;

// ═══════════════════════════════════════════════════════════
// LLM judge prompts — TWO judges with deliberately different lenses.
//
// CRAFT judge: a developmental editor's lens. Cares about prose, voice,
// scene-level execution. The classic "show vs tell" / "emotional truth"
// dimensions. NOT an English-professor / literary-fiction lens — this is
// "what makes prose good in genre fiction." We're not optimizing for
// MFA-thesis aesthetic; we're optimizing for prose that pulls a paying
// reader through.
//
// MARKET judge: an acquiring-editor + agent's lens. Cares about
// commercial signals — what makes a book sell, get finished, get reviewed,
// get word-of-mouth. Hook strength, pacing energy, tropes executed,
// page-turning quality, comp-title alignment, ending payoff. Specifically
// NOT a "let me make this more tasteful" lens — these are the things that
// drive sales-through and reader retention.
//
// THE DISAGREEMENT IS THE SIGNAL. If both judges love it, ship it. If
// both hate it, revise. If they disagree on the same chapter, the chapter
// is doing something interesting that may or may not be working — that's
// the most actionable signal of all.
// ═══════════════════════════════════════════════════════════

const CRAFT_JUDGE_SYSTEM_PROMPT = `You are a senior developmental editor at a respected commercial imprint. Score this chapter of fiction on six dimensions, 1-10 each.

You are NOT an English professor evaluating a literary thesis. You are evaluating prose that has to work for a paying reader who picked up this book voluntarily and will close it if it bores them. "Good craft" here means craft in the service of the reader experience, not craft as MFA-shibboleth.

1. **voice_consistency** — Is the narrator's voice distinctive and consistent? Does the prose feel like it has a person behind it?
2. **show_vs_tell** — Does the chapter show emotion through gesture/action/sensation, or tell it via labels?
3. **pacing** — Does tension rise and fall purposefully? Is there a satisfying arc WITHIN this chapter?
4. **dialogue_authenticity** — Do characters sound distinct from each other and from the narrator? Is there subtext, or is dialogue purely informational?
5. **sensory_grounding** — Are scenes anchored in physical detail across multiple senses, or floating in abstraction?
6. **emotional_truth** — Do emotional beats feel earned? Does the reader feel something specific (not just "it's emotional" — what specifically)?

For each dimension provide 1-3 SPECIFIC issues (concrete, actionable — never generic). If a dimension is genuinely strong, write a 1-issue note saying so.

Return ONLY valid JSON in this exact format:
{
  "dimensions": [
    {"name": "voice_consistency", "score": 7, "issues": ["The narrator slips into a clinical register in paragraph 5 ('it could be observed that...')"]},
    {"name": "show_vs_tell", "score": 6, "issues": ["Sarah 'felt scared' three times in the opening — replace with physiology", "The grief on page 2 is told ('she was sad') instead of shown"]},
    ...
  ]
}

No commentary outside the JSON. No markdown code fences.`;

const MARKET_JUDGE_SYSTEM_PROMPT = `You are an acquiring editor + literary agent who lives by sell-through numbers, completion rates, and word-of-mouth. You are evaluating a chapter of commercial fiction for COMMERCIAL VIABILITY — what makes a book sell, get finished, get reviewed, and get recommended.

You are NOT applying a "literary tastefulness" filter. You are applying a "would a paying reader keep reading and tell their friend?" filter. Pulpy beats elegant if pulpy keeps the page turning. Tropes are tools, not problems. Genre conventions are reader expectations the book is hired to deliver.

Score this chapter on six commercial dimensions, 1-10 each:

1. **hook_strength** — Does the opening line / paragraph / first scene give a reader a reason NOT to put this down? Specifically: a question, a stake, a voice, an irresistible image, a forward motion?
2. **page_turn_quality** — Does each scene end with momentum into the next? Are there "I have to keep reading" moments? (Mid-chapter cliffhangers, escalating questions, deferred gratification.)
3. **trope_execution** — When the chapter leans on genre tropes (and it should), are the tropes EXECUTED with energy? Reader expectations met OR subverted in a satisfying way? (Romance: the right beats hit. Thriller: the right beats hit. Mystery: clue placement works. Etc.)
4. **comp_alignment** — Does this read like it belongs on the same shelf as the bestselling current titles in its subgenre? Voice, pacing, tone, scene-energy match what's selling RIGHT NOW (not what was selling 10 years ago)?
5. **reader_emotional_payoff** — Does the chapter end having delivered SOMETHING the reader picked up the book for? Even small payoffs (a moment of intimacy in a romance, a clue in a mystery, a kill in a horror) — readers reward books that pay them every chapter.
6. **commercial_polish** — Is this prose READABLE — clear, fast, friction-free? Sentences don't trip you up. Dialogue is propulsive. No "literary" speed bumps that would lose a Kindle Unlimited reader on page 3.

For each dimension provide 1-3 SPECIFIC issues (concrete, actionable — never generic). Don't recommend literary improvements that would HURT commercial readability. If the chapter is doing something deliberately uncommercial, flag it as a deliberate trade-off and call out which commercial dimension is taking the hit.

Return ONLY valid JSON in this exact format:
{
  "dimensions": [
    {"name": "hook_strength", "score": 7, "issues": ["Opening line is solid but the next two paragraphs slow into description — consider tightening to land the inciting tension faster"]},
    {"name": "page_turn_quality", "score": 6, "issues": ["Chapter ends on a quiet beat — readers like reasons to flip the page; consider ending on a question or arrival"]},
    ...
  ]
}

No commentary outside the JSON. No markdown code fences.`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class WritingJudgeService {
  /** Run the deterministic mechanical screen. Cheap; safe to run on every draft. */
  mechanicalScreen(text: string): MechanicalReport {
    const issues: MechanicalIssue[] = [];
    const wordCount = text.split(/\s+/).filter(Boolean).length || 1;
    const wordsLower = text.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z'\-]/g, ''));

    // ── AI-tell words ──
    {
      let count = 0;
      const examples: string[] = [];
      for (const re of AI_TELL_PATTERNS) {
        const matches = text.match(re);
        if (matches) {
          count += matches.length;
          examples.push(...matches.slice(0, 2));
        }
      }
      if (count > 0) {
        issues.push({
          category: 'ai_tell',
          severity: count > 3 ? 'error' : 'warning',
          description: `${count} AI-tell phrases found. These signal LLM prose to careful readers.`,
          examples: Array.from(new Set(examples)).slice(0, 5),
          count,
        });
      }
    }

    // ── Banned cliches ──
    {
      let count = 0;
      const examples: string[] = [];
      for (const re of BANNED_PHRASES) {
        const matches = text.match(re);
        if (matches) {
          count += matches.length;
          examples.push(...matches.slice(0, 1));
        }
      }
      if (count > 0) {
        issues.push({
          category: 'banned_phrase',
          severity: count > 2 ? 'error' : 'warning',
          description: `${count} cliché phrase${count === 1 ? '' : 's'} that should be replaced.`,
          examples: Array.from(new Set(examples)).slice(0, 5),
          count,
        });
      }
    }

    // ── Filter words ──
    {
      let count = 0;
      for (const w of wordsLower) if (FILTER_WORDS.has(w)) count++;
      const rate = (count / wordCount) * 1000;
      if (rate > 8) {
        issues.push({
          category: 'filter_word',
          severity: rate > 14 ? 'error' : 'warning',
          description: `${count} filter words (${rate.toFixed(1)}/1000) — saw, heard, felt, noticed, realized. They distance the reader from the POV character.`,
          examples: [],
          count,
        });
      }
    }

    // ── Adverb density ──
    {
      let adverbs = 0;
      for (const w of wordsLower) {
        if (w.length > 3 && w.endsWith('ly') && !NON_ADVERB_LY.has(w)) adverbs++;
      }
      const rate = (adverbs / wordCount) * 1000;
      if (rate > 12) {
        issues.push({
          category: 'adverb_density',
          severity: rate > 20 ? 'error' : 'warning',
          description: `${adverbs} -ly adverbs (${rate.toFixed(1)}/1000). Strong verbs beat adverb crutches.`,
          examples: [],
          count: adverbs,
        });
      }
    }

    // ── Passive voice ──
    {
      const matches = text.match(PASSIVE_VOICE_RE) || [];
      const rate = (matches.length / wordCount) * 1000;
      if (rate > 8) {
        issues.push({
          category: 'passive_voice',
          severity: rate > 14 ? 'error' : 'warning',
          description: `${matches.length} passive constructions (${rate.toFixed(1)}/1000). Active voice tightens prose.`,
          examples: matches.slice(0, 3),
          count: matches.length,
        });
      }
    }

    // ── Weak verbs ──
    {
      const matches = text.match(WEAK_VERBS_RE) || [];
      const rate = (matches.length / wordCount) * 1000;
      if (rate > 30) {
        issues.push({
          category: 'weak_verb',
          severity: rate > 50 ? 'warning' : 'info',
          description: `${matches.length} weak verbs (was/were/had been/got/went) per 1000 words: ${rate.toFixed(1)}.`,
          examples: [],
          count: matches.length,
        });
      }
    }

    // ── Started-to / began-to ──
    {
      const matches = text.match(STARTED_TO_RE) || [];
      if (matches.length >= 3) {
        issues.push({
          category: 'started_to',
          severity: matches.length > 6 ? 'warning' : 'info',
          description: `${matches.length} "started to" / "began to" constructions. Usually drop the auxiliary.`,
          examples: matches.slice(0, 3),
          count: matches.length,
        });
      }
    }

    // ── Suddenly ──
    {
      const matches = text.match(SUDDENLY_RE) || [];
      if (matches.length >= 2) {
        issues.push({
          category: 'suddenly',
          severity: matches.length > 4 ? 'warning' : 'info',
          description: `"Suddenly" appears ${matches.length}× — almost always cuttable; the action itself implies the sudden.`,
          examples: [],
          count: matches.length,
        });
      }
    }

    // ── Hedge density ──
    {
      let count = 0;
      for (const w of wordsLower) if (HEDGE_WORDS.has(w)) count++;
      const rate = (count / wordCount) * 1000;
      if (rate > 6) {
        issues.push({
          category: 'hedge_word',
          severity: rate > 12 ? 'warning' : 'info',
          description: `${count} hedge words (${rate.toFixed(1)}/1000) — perhaps, maybe, might, somewhat, rather. Sap urgency when overused.`,
          examples: [],
          count,
        });
      }
    }

    // Composite score: 100 minus weighted penalties.
    let score = 100;
    for (const issue of issues) {
      const weight = issue.severity === 'error' ? 18
                   : issue.severity === 'warning' ? 8
                   : 3;
      score -= weight;
    }
    score = Math.max(0, Math.min(100, score));

    return { wordCount, issues, score };
  }

  /** Run the LLM judge — one AI call, structured JSON output.
   *  @param kind Which lens to apply: 'craft' (developmental editor) or
   *              'market' (acquiring editor + agent). */
  async llmJudge(
    text: string,
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
    kind: JudgeKind = 'craft',
  ): Promise<JudgeReport | null> {
    const provider = aiSelectProvider('revision');
    // Cap input — judge doesn't need the entire chapter to score it; first 8K
    // chars is plenty for an editor's read.
    const sample = text.length > 8000
      ? text.slice(0, 4000) + '\n\n[...middle truncated for evaluation...]\n\n' + text.slice(-3000)
      : text;

    const systemPrompt = kind === 'market' ? MARKET_JUDGE_SYSTEM_PROMPT : CRAFT_JUDGE_SYSTEM_PROMPT;

    let raw = '';
    try {
      const response = await aiComplete({
        provider: provider.id,
        system: systemPrompt,
        messages: [{ role: 'user', content: sample }],
        maxTokens: 1500,
        temperature: 0.3,
      });
      raw = response.text || '';
    } catch (err) {
      console.warn(`  [writing-judge] ${kind} judge LLM call failed:`, (err as Error)?.message || err);
      return null;
    }

    // Parse JSON defensively (same approach as ContextEngine).
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) {
      console.warn('  [writing-judge] judge returned non-JSON; skipping LLM scoring');
      return null;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned.substring(start, end + 1));
    } catch {
      try {
        parsed = JSON.parse(cleaned.substring(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return null;
      }
    }

    const dims: JudgeDimension[] = Array.isArray(parsed?.dimensions)
      ? parsed.dimensions.filter((d: any) =>
          typeof d?.name === 'string' && typeof d.score === 'number' && Array.isArray(d.issues))
      : [];
    if (dims.length === 0) return null;

    const overall = dims.reduce((sum, d) => sum + Math.max(1, Math.min(10, d.score)), 0) / dims.length;
    // Top issues = lowest-scoring dimensions' first issue, capped at 3.
    const topIssues = [...dims]
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(d => `[${d.name} ${d.score}/10] ${d.issues[0] || ''}`)
      .filter(s => s.length > 5);

    return {
      kind,
      dimensions: dims.map(d => ({
        name: d.name,
        score: Math.round(Math.max(1, Math.min(10, d.score)) * 10) / 10,
        issues: (d.issues || []).slice(0, 3),
      })),
      overall: Math.round(overall * 10) / 10,
      topIssues,
    };
  }

  /**
   * Combined evaluation. Returns a verdict including whether to retry.
   *
   * Default scoring weights:
   *   - mechanical 30%, judge 70% (judge catches things mechanical can't,
   *     mechanical catches things judge writes itself)
   * Threshold default: 70/100. Below = retry.
   */
  async evaluate(
    text: string,
    opts: {
      aiComplete?: AICompleteFn;
      aiSelectProvider?: AISelectProviderFn;
      threshold?: number;        // 0-100; default 70
      mechanicalWeight?: number; // 0-1; default 0.3
      runLLMJudge?: boolean;     // default true if AI fns provided
      /** Run BOTH craft + market judges in parallel and produce a dual
       *  analysis. Doubles the LLM cost but surfaces craft↔market
       *  disagreement, which is the most actionable signal. Default false. */
      dualJudge?: boolean;
    } = {}
  ): Promise<QualityVerdict> {
    const mechanical = this.mechanicalScreen(text);
    const aiAvailable = opts.runLLMJudge !== false && opts.aiComplete && opts.aiSelectProvider;

    let judge: JudgeReport | null = null;
    let dualJudge: DualJudgeAnalysis | null = null;

    if (aiAvailable) {
      if (opts.dualJudge) {
        // Run both judges in parallel.
        const [craftReport, marketReport] = await Promise.all([
          this.llmJudge(text, opts.aiComplete!, opts.aiSelectProvider!, 'craft'),
          this.llmJudge(text, opts.aiComplete!, opts.aiSelectProvider!, 'market'),
        ]);
        if (craftReport && marketReport) {
          const combined100 = ((craftReport.overall + marketReport.overall) / 2) * 10;
          const gap = Math.abs(craftReport.overall - marketReport.overall) * 10;
          const disagreementNote = this.buildDisagreementNote(craftReport, marketReport, gap);
          dualJudge = {
            craft: craftReport,
            market: marketReport,
            combinedOverall100: Math.round(combined100 * 10) / 10,
            disagreementGap: Math.round(gap * 10) / 10,
            disagreementNote,
          };
        } else if (craftReport) {
          // Market judge failed — fall back to single craft.
          judge = craftReport;
        } else if (marketReport) {
          judge = marketReport;
        }
      } else {
        // Single judge — defaults to craft (the original behavior).
        judge = await this.llmJudge(text, opts.aiComplete!, opts.aiSelectProvider!, 'craft');
      }
    }

    const mechWeight = opts.mechanicalWeight ?? 0.3;
    const judgeWeight = 1 - mechWeight;

    // Normalize judge to 0-100 scale.
    let judgeScore100: number | null = null;
    if (dualJudge) judgeScore100 = dualJudge.combinedOverall100;
    else if (judge) judgeScore100 = judge.overall * 10;

    let combined: number;
    if (judgeScore100 !== null) {
      combined = mechanical.score * mechWeight + judgeScore100 * judgeWeight;
    } else {
      combined = mechanical.score; // Mechanical-only fallback.
    }
    combined = Math.round(combined * 10) / 10;

    const threshold = opts.threshold ?? 70;
    const retry = combined < threshold;

    // Build retry feedback — concise actionable steering for the next draft.
    const feedbackLines: string[] = [];
    if (dualJudge) {
      // Surface BOTH craft and market issues + the disagreement (if any).
      if (dualJudge.craft.topIssues.length > 0) {
        feedbackLines.push('## Craft issues to fix (developmental editor)');
        for (const issue of dualJudge.craft.topIssues) feedbackLines.push(`- ${issue}`);
      }
      if (dualJudge.market.topIssues.length > 0) {
        feedbackLines.push('\n## Market issues to fix (commercial / sell-through)');
        for (const issue of dualJudge.market.topIssues) feedbackLines.push(`- ${issue}`);
      }
      if (dualJudge.disagreementGap >= 15) {
        feedbackLines.push(`\n## ⚠ Craft + Market judges disagree`);
        feedbackLines.push(dualJudge.disagreementNote);
      }
    } else if (judge && judge.topIssues.length > 0) {
      feedbackLines.push('## Top issues to fix on rewrite');
      for (const issue of judge.topIssues) feedbackLines.push(`- ${issue}`);
    }

    if (mechanical.issues.length > 0) {
      const errors = mechanical.issues.filter(i => i.severity === 'error');
      const warnings = mechanical.issues.filter(i => i.severity === 'warning');
      if (errors.length > 0) {
        feedbackLines.push('\n## Mechanical errors');
        for (const e of errors) {
          feedbackLines.push(`- ${e.description}${e.examples.length > 0 ? ` (e.g., "${e.examples[0]}")` : ''}`);
        }
      }
      if (warnings.length > 0) {
        feedbackLines.push('\n## Mechanical warnings');
        for (const w of warnings.slice(0, 4)) {
          feedbackLines.push(`- ${w.description}`);
        }
      }
    }
    const retryFeedback = feedbackLines.join('\n');

    let summary: string;
    if (dualJudge) {
      summary = `Score ${combined}/100 (mech ${mechanical.score}, craft ${dualJudge.craft.overall}/10, market ${dualJudge.market.overall}/10` +
        `${dualJudge.disagreementGap >= 15 ? `, gap ${dualJudge.disagreementGap}` : ''}). ` +
        `${retry ? '↻ retry' : '✓ pass'}.`;
    } else if (judge) {
      summary = `Score ${combined}/100 (mechanical ${mechanical.score}, ${judge.kind} judge ${judge.overall}/10). ${retry ? '↻ retry' : '✓ pass'}.`;
    } else {
      summary = `Score ${combined}/100 (mechanical-only). ${retry ? '↻ retry' : '✓ pass'}.`;
    }

    return { score: combined, retry, mechanical, judge, dualJudge, summary, retryFeedback };
  }

  /** Plain-English read of a craft↔market disagreement, when meaningful. */
  private buildDisagreementNote(craft: JudgeReport, market: JudgeReport, gap: number): string {
    if (gap < 15) {
      return `Both judges agree (within ${gap.toFixed(1)} points). The chapter is doing what it intends.`;
    }
    const craftLed = craft.overall > market.overall;
    const winner = craftLed ? 'CRAFT' : 'MARKET';
    const loser = craftLed ? 'MARKET' : 'CRAFT';
    const reasoning = craftLed
      ? `${winner} judge sees strong prose but ${loser} judge says the chapter doesn't hook a paying reader / lacks page-turn quality / strays from current comp-title energy. The prose may be technically good but commercially soft. Worth checking: opening line strength, scene-end momentum, trope execution.`
      : `${winner} judge sees strong commercial signals (hook, pacing, page-turn) but ${loser} judge sees prose-level problems — voice slips, weak emotional truth, or scene-level execution gaps. Commercially the chapter works, but the writing under it could be sharper. Worth checking: dialogue authenticity, sensory grounding, voice consistency.`;
    return `Gap of ${gap.toFixed(1)} points — ${craftLed ? 'craft scored higher' : 'market scored higher'}. ${reasoning} ` +
      `If both fixes contradict, prioritize ${winner} for now and revisit ${loser} on the next pass.`;
  }
}
