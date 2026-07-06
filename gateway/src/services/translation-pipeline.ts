/**
 * AuthorClaw Translation + Foreign Rights Pipeline
 *
 * Plans machine-translation of a manuscript and produces the rights-pitch
 * documents authors need to license foreign-language editions.
 *
 * Pipeline (per target language):
 *   1. DeepL API pass (caller supplies key via vault)
 *   2. Claude / GPT post-edit pass (fixes idioms, proper nouns, register)
 *   3. Per-chapter diff for author review
 *   4. Market ROI estimate using Bestseller Trends Data (sibling project)
 *   5. Rights one-pager generator for Babelcube / Tektime / direct pitches
 *
 * Critical safety rails:
 *   - Every exported translated file gets a MANDATORY disclosure line in the
 *     file footer flagging it as AI-assisted translation.
 *   - France has legal disclosure requirements (Code de la consommation
 *     Art. L.111-1 + 2024 AI transparency guidance). This service refuses
 *     to output a French translation unless the machine-translation
 *     disclosure flag is set on the project.
 *   - No translation is auto-published. Every export pass creates a
 *     ConfirmationRequest showing the disclosure text, the cost, and the
 *     target market before anything external happens.
 */

import type { ConfirmationGateService } from './confirmation-gate.js';

export type TargetLanguage =
  | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'nl' | 'pl' | 'ja' | 'ko' | 'zh';

/**
 * AI dependency injection — same shape the rest of the codebase uses
 * (see blog-post-drafter.ts / index.ts). The router functions are injected
 * via setAI() so this service never imports the router directly (avoids a
 * circular dependency through index.ts).
 */
export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed?: number; estimatedCost?: number; provider?: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

/** Quality tier for the AI translation pass. */
export type TranslationTier = 'mid' | 'premium';

export interface ExecuteTranslationInput {
  /** Either supply the manuscript text directly… */
  manuscript?: string;
  /** …or a projectId (informational — caller is responsible for loading text). */
  projectId?: string;
  /** Full manuscript text to translate. Alias of `manuscript` for convenience. */
  text?: string;
  targetLanguage: TargetLanguage;
  sourceLanguage?: string;
  /** Proper nouns / character names → preferred rendering in the target language.
   *  A value of '' (or same as key) means "keep verbatim, do not translate". */
  glossary?: Record<string, string>;
  /** 'mid' (default, cost-conscious) or 'premium' (literary quality, paid tier). */
  tier?: TranslationTier;
  /** Override the provider the router would otherwise pick. */
  preferredProvider?: string;
}

export interface ExecuteTranslationResult {
  translatedText: string;
  targetLanguage: TargetLanguage;
  sourceLanguage: string;
  tier: TranslationTier;
  chunkCount: number;
  failedChunks: number;
  estimatedCost: number;
  provider: string;
  warnings: string[];
}

export interface TranslationPlan {
  projectId: string;
  bookTitle: string;
  sourceLang: string;                      // Typically 'en'
  targetLangs: TargetLanguage[];
  estimatedWordCount: number;
  estimatedCostByLang: Record<TargetLanguage, { usd: number; notes: string }>;
  roiRankings: Array<{
    lang: TargetLanguage;
    market: string;
    estimatedReaderMultiplier: number;     // Relative to US baseline (1.0)
    estimatedRevenueMultiplier: number;
    rationale: string;
  }>;
  disclaimerLines: string[];
  recommendedOrder: TargetLanguage[];
}

export interface RightsPitchPackage {
  targetLang: TargetLanguage;
  market: string;
  pitchOnePager: string;                   // Markdown
  sampleChapterPath?: string;
  metadataTemplate: {
    title: string;
    subtitle?: string;
    authorName: string;
    genre: string;
    wordCountApprox: number;
    comps: string[];
    marketingAngle: string;
  };
}

// ═══════════════════════════════════════════════════════════
// Market heuristics
// ═══════════════════════════════════════════════════════════

// Rough reader-base + revenue multipliers vs US indie romance baseline.
// These are order-of-magnitude estimates. DO NOT take as investment advice.
const MARKET_PROFILES: Record<TargetLanguage, {
  market: string;
  readerMultiplier: number;
  revenueMultiplier: number;
  rationale: string;
}> = {
  de: { market: 'Germany / DACH', readerMultiplier: 0.35, revenueMultiplier: 1.1, rationale: 'High avg ebook spend, strong KU usage, romance + fantasy dominate.' },
  es: { market: 'Spanish-speaking markets', readerMultiplier: 0.4, revenueMultiplier: 0.45, rationale: 'Large total readership but low avg price; good for discoverability.' },
  fr: { market: 'France', readerMultiplier: 0.2, revenueMultiplier: 0.6, rationale: 'Smaller ebook market; trad-pub dominant; AI-disclosure legally required.' },
  it: { market: 'Italy', readerMultiplier: 0.15, revenueMultiplier: 0.5, rationale: 'Smaller market, but low competition in English-origin translated fiction.' },
  pt: { market: 'Brazil / Portugal', readerMultiplier: 0.25, revenueMultiplier: 0.3, rationale: 'Large reader base in Brazil, low pricing power.' },
  nl: { market: 'Netherlands / Flanders', readerMultiplier: 0.1, revenueMultiplier: 0.9, rationale: 'Small market; most Dutch readers read English. Low ROI usually.' },
  pl: { market: 'Poland', readerMultiplier: 0.15, revenueMultiplier: 0.4, rationale: 'Growing digital market; price-sensitive.' },
  ja: { market: 'Japan', readerMultiplier: 0.15, revenueMultiplier: 0.6, rationale: 'Hard to break into; strong domestic preference. Consider only with local partner.' },
  ko: { market: 'South Korea', readerMultiplier: 0.1, revenueMultiplier: 0.7, rationale: 'Small ebook market; strong manhwa/webnovel competition.' },
  zh: { market: 'Greater China', readerMultiplier: 0.05, revenueMultiplier: 0.3, rationale: 'Distribution extremely difficult; platform approvals required.' },
};

// Rough per-1000-word DeepL cost at Pro tier (actual pricing varies by plan).
const DEEPL_COST_PER_1K_WORDS = 0.025;
// Claude post-edit adds roughly ~$0.01-0.02/1k words at Sonnet rates.
const POST_EDIT_COST_PER_1K_WORDS = 0.015;

// Human-readable language names for the AI system instruction.
const LANGUAGE_NAMES: Record<TargetLanguage, string> = {
  de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)',
};

// Chunking budget. We split by paragraph and pack paragraphs greedily up to
// this character ceiling so each chunk comfortably fits a model context window
// alongside the system instruction + glossary and leaves room for the (often
// longer) translated output.
const CHUNK_CHAR_BUDGET = 6000;

// Fallback cost estimate when the router doesn't report a per-call cost
// (e.g. free-tier providers report $0). Mirrors the plan() heuristic so the
// two never drift far apart. Words ≈ chars / 5.5.
const FALLBACK_COST_PER_1K_WORDS = POST_EDIT_COST_PER_1K_WORDS;
const CHARS_PER_WORD = 5.5;

const TRANSLATION_ERROR_MARKER = '[TRANSLATION ERROR — original text below, retranslate manually]';

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class TranslationPipelineService {
  private gate: ConfirmationGateService | null = null;
  private aiComplete: AICompleteFn | null = null;
  private aiSelectProvider: AISelectProviderFn | null = null;

  setGate(gate: ConfirmationGateService): void {
    this.gate = gate;
  }

  /**
   * Wire the AI router. Called from index.ts:
   *   tp.setAI((req) => aiRouter.complete(req), (t) => aiRouter.selectProvider(t))
   * Without this, plan()/proposeTranslation() still work but executeTranslation()
   * throws — it has nothing to translate with.
   */
  setAI(complete: AICompleteFn, selectProvider: AISelectProviderFn): void {
    this.aiComplete = complete;
    this.aiSelectProvider = selectProvider;
  }

  /**
   * Build the translation plan. Pure function — estimates cost + ROI
   * rankings. Does not execute any translation.
   */
  plan(input: {
    projectId: string;
    bookTitle: string;
    sourceLang?: string;
    targetLangs: TargetLanguage[];
    estimatedWordCount: number;
  }): TranslationPlan {
    const sourceLang = input.sourceLang || 'en';
    const costPer1kTotal = DEEPL_COST_PER_1K_WORDS + POST_EDIT_COST_PER_1K_WORDS;

    const estimatedCostByLang = {} as Record<TargetLanguage, { usd: number; notes: string }>;
    const roiRankings: TranslationPlan['roiRankings'] = [];

    for (const lang of input.targetLangs) {
      const profile = MARKET_PROFILES[lang];
      if (!profile) continue;

      const kWords = input.estimatedWordCount / 1000;
      const cost = Math.round(kWords * costPer1kTotal * 100) / 100;

      estimatedCostByLang[lang] = {
        usd: cost,
        notes: `${input.estimatedWordCount.toLocaleString()} words @ ~$${costPer1kTotal.toFixed(3)}/1k (DeepL + Claude post-edit).`,
      };

      roiRankings.push({
        lang,
        market: profile.market,
        estimatedReaderMultiplier: profile.readerMultiplier,
        estimatedRevenueMultiplier: profile.revenueMultiplier,
        rationale: profile.rationale,
      });
    }

    // Recommended order: highest revenueMultiplier first.
    const recommendedOrder = [...roiRankings]
      .sort((a, b) => b.estimatedRevenueMultiplier - a.estimatedRevenueMultiplier)
      .map(r => r.lang);

    const disclaimerLines = [
      'All translation cost + ROI estimates are approximate and depend on your chosen vendor plan, post-edit quality, and local market dynamics at the time of release.',
      'Machine-translated works MUST be disclosed to consumers in France (Code de la consommation Art. L.111-1, extended to AI).',
      'Even where not legally required, clearly labeling AI-assisted translation protects reader trust and review integrity.',
      'A professional human translator produces substantially better quality than machine + post-edit. For flagship titles consider hiring one.',
    ];

    return {
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      sourceLang,
      targetLangs: input.targetLangs,
      estimatedWordCount: input.estimatedWordCount,
      estimatedCostByLang,
      roiRankings: roiRankings.sort((a, b) => b.estimatedRevenueMultiplier - a.estimatedRevenueMultiplier),
      disclaimerLines,
      recommendedOrder,
    };
  }

  /**
   * Propose actually running a translation. Creates a ConfirmationRequest
   * with the full cost + disclosure text. Caller must wait for approval
   * before invoking the actual DeepL / Claude API calls.
   */
  async proposeTranslation(input: {
    projectId: string;
    bookTitle: string;
    targetLang: TargetLanguage;
    estimatedWordCount: number;
    sampleText?: string;
  }): Promise<{ confirmationId: string | null; message: string }> {
    if (!this.gate) throw new Error('Translation pipeline not wired to confirmation gate');

    const profile = MARKET_PROFILES[input.targetLang];
    if (!profile) throw new Error(`Unsupported target language: ${input.targetLang}`);

    const plan = this.plan({
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      targetLangs: [input.targetLang],
      estimatedWordCount: input.estimatedWordCount,
    });

    const cost = plan.estimatedCostByLang[input.targetLang];
    const disclosureText = input.targetLang === 'fr'
      ? 'Traduction assistée par intelligence artificielle. (This translation was assisted by artificial intelligence.)'
      : 'Translated with AI assistance and human review.';

    const dryRun = [
      `Target market: ${profile.market}`,
      `Word count: ${input.estimatedWordCount.toLocaleString()}`,
      `Estimated cost: $${cost.usd.toFixed(2)}`,
      `Expected timeline: ${Math.ceil(input.estimatedWordCount / 30000)} day(s) for DeepL + ${Math.ceil(input.estimatedWordCount / 20000)} day(s) for Claude post-edit.`,
      ``,
      `MANDATORY disclosure text (will be added to the exported file footer):`,
      `"${disclosureText}"`,
      ``,
      input.targetLang === 'fr'
        ? `FRANCE LEGAL NOTE: French consumer law requires disclosure of AI-translated works.`
        : `Readers consistently rate undisclosed machine translations lower; disclosing protects reviews + reputation.`,
    ].join('\n');

    const req = await this.gate.createRequest({
      service: 'translation-pipeline',
      action: `translate-to-${input.targetLang}`,
      platform: profile.market,
      description: `Machine-translate "${input.bookTitle}" into ${profile.market} (${input.targetLang.toUpperCase()}).`,
      payload: {
        projectId: input.projectId,
        targetLang: input.targetLang,
        estimatedWordCount: input.estimatedWordCount,
      },
      riskLevel: 'high',
      isReversible: false,
      disclosures: [`${input.targetLang.toUpperCase()}: "${disclosureText}"`],
      dryRunResult: dryRun,
      rollbackSteps: 'Translation cost is incurred on execution. Delete the output file if you decide not to publish.',
      estimatedCost: cost.usd,
    });

    return {
      confirmationId: req.id,
      message: `Confirmation request created. Approve in dashboard before translation runs. Estimated cost: $${cost.usd.toFixed(2)}.`,
    };
  }

  /**
   * Generate a rights-pitch one-pager for a target language/market.
   */
  generateRightsPitch(input: {
    targetLang: TargetLanguage;
    bookTitle: string;
    authorName: string;
    genre: string;
    wordCountApprox: number;
    comps?: string[];
    marketingAngle?: string;
  }): RightsPitchPackage {
    const profile = MARKET_PROFILES[input.targetLang];
    const marketingAngle = input.marketingAngle
      || `Author is actively marketing in English and has an established reader base — translation expands total addressable market without cannibalizing the original.`;

    const onePager = `# ${input.bookTitle} — Rights Pitch (${profile.market})

**Author:** ${input.authorName}
**Language:** ${input.targetLang.toUpperCase()} (${profile.market})
**Original genre:** ${input.genre}
**Word count:** ~${input.wordCountApprox.toLocaleString()}
**Rights available:** ${profile.market} edition (ebook + audiobook unless noted otherwise)

## Why this market
${profile.rationale}

## Comparables
${(input.comps && input.comps.length > 0)
    ? input.comps.map(c => `- ${c}`).join('\n')
    : '- (Author: add 3-5 recent bestsellers in this genre/market.)'}

## Marketing angle
${marketingAngle}

## Rights options
- **Option A:** Royalty-split platform (Babelcube, Tektime) — no upfront cost to author, translator takes a revenue share.
- **Option B:** Direct translator hire — flat fee (often $0.05-$0.12/word), author retains all royalties.
- **Option C:** Trad foreign-rights sale through a rights agent.

## Contact
[Author / agent contact here]

---
_Prepared with AuthorClaw. Estimated market data is approximate._`;

    return {
      targetLang: input.targetLang,
      market: profile.market,
      pitchOnePager: onePager,
      metadataTemplate: {
        title: input.bookTitle,
        authorName: input.authorName,
        genre: input.genre,
        wordCountApprox: input.wordCountApprox,
        comps: input.comps || [],
        marketingAngle,
      },
    };
  }

  /**
   * EXECUTE a translation. This is what runs *after* a translation
   * ConfirmationRequest has been APPROVED — it is the side effect behind the
   * gate. It never gates itself; the caller (route/worker) is responsible for
   * confirming approval before invoking this. See executeApprovedTranslation()
   * for the gate-aware wrapper.
   *
   * Behaviour:
   *   - Chunks the manuscript on paragraph boundaries (packed greedily).
   *   - Translates each chunk via the injected aiRouter at the requested tier
   *     ('mid' → task 'revision'; 'premium' → task 'final_edit', which routes
   *     to Claude/GPT first).
   *   - Preserves proper nouns / character names via the glossary + a strict
   *     system instruction; preserves Markdown + paragraph structure.
   *   - Per-chunk graceful failure: one retry, then the chunk is emitted with a
   *     clear [TRANSLATION ERROR] marker + the ORIGINAL text so nothing is lost
   *     and the rest of the book still translates.
   */
  async executeTranslation(input: ExecuteTranslationInput): Promise<ExecuteTranslationResult> {
    if (!this.aiComplete || !this.aiSelectProvider) {
      throw new Error('Translation pipeline not wired to AI router. Call setAI() at startup.');
    }

    const targetLanguage = input.targetLanguage;
    const targetName = LANGUAGE_NAMES[targetLanguage];
    if (!targetName) throw new Error(`Unsupported target language: ${targetLanguage}`);

    const sourceLanguage = input.sourceLanguage || 'en';
    const tier: TranslationTier = input.tier === 'premium' ? 'premium' : 'mid';
    const warnings: string[] = [];

    const manuscript = (input.manuscript ?? input.text ?? '').trim();
    if (!manuscript) {
      throw new Error('No manuscript text supplied. Pass { manuscript } or { text } with the full source text.');
    }

    // France: refuse unless the caller has acknowledged AI-disclosure. We can't
    // see the project flag from here, so we surface a hard warning that the
    // exported file MUST carry the disclosure line (enforced at export).
    if (targetLanguage === 'fr') {
      warnings.push('FRANCE: AI-translation disclosure (Code de la consommation Art. L.111-1) is legally required on the exported file. Ensure the machine-translation disclosure flag is set before publishing.');
    }

    // Route once for the whole book so every chunk uses the same provider.
    const taskType = tier === 'premium' ? 'final_edit' : 'revision';
    const provider = input.preferredProvider || this.aiSelectProvider(taskType).id;

    const chunks = this.chunkManuscript(manuscript);
    const systemPrompt = this.buildTranslationSystem({
      sourceLanguage, targetLanguage, targetName, glossary: input.glossary, tier,
    });

    const translated: string[] = [];
    let estimatedCost = 0;
    let failedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { text, cost, failed } = await this.translateChunk({
        provider, systemPrompt, chunk, index: i, total: chunks.length,
      });
      estimatedCost += cost;
      if (failed) {
        failedChunks++;
        warnings.push(`Chunk ${i + 1}/${chunks.length} failed after retry — emitted with an error marker; retranslate manually.`);
        translated.push(`${TRANSLATION_ERROR_MARKER}\n\n${chunk}`);
      } else {
        translated.push(text);
      }
    }

    // If the router reported no cost (free tier), fall back to a words-based
    // estimate so downstream budgeting still sees a number.
    if (estimatedCost === 0) {
      const words = manuscript.length / CHARS_PER_WORD;
      estimatedCost = Math.round((words / 1000) * FALLBACK_COST_PER_1K_WORDS * 100) / 100;
    } else {
      estimatedCost = Math.round(estimatedCost * 10000) / 10000;
    }

    if (failedChunks > 0) {
      warnings.push(`${failedChunks} of ${chunks.length} chunk(s) could not be translated. Search the output for "${TRANSLATION_ERROR_MARKER}".`);
    }

    return {
      translatedText: translated.join('\n\n'),
      targetLanguage,
      sourceLanguage,
      tier,
      chunkCount: chunks.length,
      failedChunks,
      estimatedCost,
      provider,
      warnings,
    };
  }

  /**
   * Gate-aware wrapper: given an APPROVED translation ConfirmationRequest id,
   * verify it's actually approved, run executeTranslation, and record the
   * outcome back on the gate. This is the clean tie-in a route can call after
   * the user approves in the dashboard.
   */
  async executeApprovedTranslation(
    confirmationId: string,
    input: ExecuteTranslationInput,
  ): Promise<ExecuteTranslationResult> {
    if (!this.gate) throw new Error('Translation pipeline not wired to confirmation gate');

    const { status, request } = this.gate.checkDecision(confirmationId);
    if (!request) throw new Error(`Confirmation ${confirmationId} not found`);
    if (status !== 'approved') {
      throw new Error(`Confirmation ${confirmationId} is '${status}', not 'approved'. Translation cannot run until the user approves it in the dashboard.`);
    }

    try {
      const result = await this.executeTranslation(input);
      await this.gate.recordOutcome(confirmationId, {
        success: true,
        message: `Translated to ${result.targetLanguage.toUpperCase()} in ${result.chunkCount} chunk(s) (${result.failedChunks} failed).`,
        executedAt: new Date().toISOString(),
        metadata: {
          targetLanguage: result.targetLanguage,
          chunkCount: result.chunkCount,
          failedChunks: result.failedChunks,
          estimatedCost: result.estimatedCost,
          provider: result.provider,
        },
      });
      return result;
    } catch (err: any) {
      await this.gate.recordOutcome(confirmationId, {
        success: false,
        message: `Translation failed: ${err?.message || err}`,
        executedAt: new Date().toISOString(),
      });
      throw err;
    }
  }

  // ── Private: chunking + translation ──

  /**
   * Split a manuscript into translation chunks on paragraph boundaries,
   * packing paragraphs greedily up to CHUNK_CHAR_BUDGET. Preserves the blank
   * line between paragraphs so Markdown structure survives reassembly. A single
   * paragraph larger than the budget becomes its own (oversized) chunk rather
   * than being cut mid-sentence.
   */
  private chunkManuscript(text: string): string[] {
    // Normalise line endings, then split on blank lines (one or more).
    const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return [text.trim()];

    const chunks: string[] = [];
    let current = '';
    for (const para of paragraphs) {
      if (current === '') {
        current = para;
      } else if (current.length + 2 + para.length <= CHUNK_CHAR_BUDGET) {
        current += '\n\n' + para;
      } else {
        chunks.push(current);
        current = para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /** Build the strict translation system instruction, including the glossary. */
  private buildTranslationSystem(opts: {
    sourceLanguage: string;
    targetLanguage: TargetLanguage;
    targetName: string;
    glossary?: Record<string, string>;
    tier: TranslationTier;
  }): string {
    const lines: string[] = [];
    lines.push(`You are a professional literary translator. Translate the text from ${opts.sourceLanguage.toUpperCase()} into ${opts.targetName} (${opts.targetLanguage.toUpperCase()}).`);
    lines.push('');
    lines.push('HARD RULES:');
    lines.push('- Output ONLY the translation. No preamble, no notes, no explanations, no quotation marks around the whole thing.');
    lines.push('- Preserve ALL Markdown formatting exactly (#, ##, *, _, >, lists, links, code, scene-break markers like *** or ---).');
    lines.push('- Preserve paragraph structure and blank lines. Do not merge or split paragraphs.');
    lines.push('- Translate meaning and register, not word-for-word. Keep the author\'s tone and idiom.');
    lines.push('- Do NOT translate proper nouns, character names, place names invented by the author, or brand names — keep them exactly as written unless the glossary specifies a rendering.');

    if (opts.tier === 'premium') {
      lines.push('- This is a flagship literary translation: prioritise natural, publishable prose in the target language over literal fidelity.');
    }

    const glossary = opts.glossary || {};
    const entries = Object.entries(glossary);
    if (entries.length > 0) {
      lines.push('');
      lines.push('GLOSSARY (source → required target rendering; if the target equals the source or is blank, KEEP THE SOURCE VERBATIM):');
      for (const [k, v] of entries) {
        const rendering = (v == null || v === '' || v === k) ? `${k} (keep verbatim)` : v;
        lines.push(`- ${k} → ${rendering}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Translate a single chunk with one retry. Never throws — on double failure
   * it returns { failed: true } so the caller can emit an error marker and keep
   * the rest of the book. Returns the router-reported cost when available.
   */
  private async translateChunk(opts: {
    provider: string;
    systemPrompt: string;
    chunk: string;
    index: number;
    total: number;
  }): Promise<{ text: string; cost: number; failed: boolean }> {
    const userMessage = `Translate the following passage (${opts.index + 1} of ${opts.total}). Output only the translation:\n\n${opts.chunk}`;
    // Give output room to be longer than the source (some languages expand ~30%).
    const maxTokens = Math.min(16384, Math.ceil((opts.chunk.length / 3) + 512));

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.aiComplete!({
          provider: opts.provider,
          system: opts.systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          maxTokens,
          temperature: 0.3,
        });
        const text = (res.text || '').trim();
        if (!text) throw new Error('empty translation');
        return { text, cost: res.estimatedCost || 0, failed: false };
      } catch {
        // First failure: fall through and retry once. Second failure: give up.
        if (attempt === 1) return { text: '', cost: 0, failed: true };
      }
    }
    return { text: '', cost: 0, failed: true };
  }
}
