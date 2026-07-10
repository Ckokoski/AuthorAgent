/**
 * AuthorAgent Central Pricing Table
 *
 * Single source of truth for hardcoded cost estimates used across services
 * (image generation, launch orchestration, ad planning, etc). Centralizing
 * these avoids the same dollar figure drifting out of sync in multiple files
 * as provider pricing changes.
 *
 * IMPORTANT: These are estimates, not billing-grade figures. Always confirm
 * current pricing on the provider's pricing page before relying on this for
 * financial decisions. `lastVerified` tracks when these numbers were last
 * checked against provider docs — treat anything older than ~90 days with
 * suspicion and re-verify.
 */

/** ISO date this table was last checked against provider pricing pages. */
export const PRICING_LAST_VERIFIED = '2026-07-06';

export type CostConfidence = 'listed' | 'rough';

export interface PriceEntry {
  /** USD cost estimate. */
  usd: number;
  /** 'listed' = taken directly from a provider price sheet.
   *  'rough' = ballpark / heuristic, no authoritative source. */
  confidence: CostConfidence;
  /** Human-readable note — unit, source, caveats. */
  note: string;
}

export const PRICING = {
  lastVerified: PRICING_LAST_VERIFIED,

  /** Image generation, per-image, by provider + size. */
  image: {
    openai: {
      // gpt-image-1, high quality. Low/medium quality use the multipliers below.
      '1024x1024': { usd: 0.17, confidence: 'listed', note: 'gpt-image-1, high quality, 1024x1024 (square)' } as PriceEntry,
      '1024x1536': { usd: 0.25, confidence: 'listed', note: 'gpt-image-1, high quality, 1024x1536 (portrait/book cover)' } as PriceEntry,
      '1536x1024': { usd: 0.25, confidence: 'listed', note: 'gpt-image-1, high quality, 1536x1024 (landscape)' } as PriceEntry,
      /** Multiply the high-quality price by this factor for other quality settings. */
      qualityMultiplier: {
        low: 0.25,
        medium: 0.5,
        high: 1.0,
        auto: 1.0,
      } as Record<'low' | 'medium' | 'high' | 'auto', number>,
    },
    /** gpt-image-2 — pricing not yet published by OpenAI at time of writing.
     *  Mirrors gpt-image-1 figures as a placeholder; confidence is 'rough'
     *  and MUST be re-verified once OpenAI publishes gpt-image-2 pricing. */
    'openai-gpt-image-2': {
      '1024x1024': { usd: 0.17, confidence: 'rough', note: 'gpt-image-2 — pricing unverified, mirrors gpt-image-1 high-quality 1024x1024 as a placeholder' } as PriceEntry,
      '1024x1536': { usd: 0.25, confidence: 'rough', note: 'gpt-image-2 — pricing unverified, mirrors gpt-image-1 high-quality 1024x1536 as a placeholder' } as PriceEntry,
      '1536x1024': { usd: 0.25, confidence: 'rough', note: 'gpt-image-2 — pricing unverified, mirrors gpt-image-1 high-quality 1536x1024 as a placeholder' } as PriceEntry,
      qualityMultiplier: {
        low: 0.25,
        medium: 0.5,
        high: 1.0,
        auto: 1.0,
      } as Record<'low' | 'medium' | 'high' | 'auto', number>,
    },
    gemini: {
      // Nano Banana (Gemini 2.5 Flash Image) — priced per image on the paid tier;
      // free tier authors typically pay $0.
      default: { usd: 0.039, confidence: 'rough', note: 'Gemini 2.5 Flash Image, approx per-image cost on paid tier; free tier is $0 but rate-limited' } as PriceEntry,
    },
    together: {
      // FLUX.1-schnell-Free is free; FLUX.1.1-pro is the paid fallback.
      free: { usd: 0, confidence: 'listed', note: 'FLUX.1-schnell-Free — no charge' } as PriceEntry,
      pro: { usd: 0.04, confidence: 'rough', note: 'FLUX.1.1-pro, approx per-image cost' } as PriceEntry,
    },
  },

  /** Rough per-step cost estimates for launch-orchestrator timeline steps,
   *  keyed by a lowercase substring match against the step's platform/action.
   *  Used only when no more specific estimate is available. */
  launchSteps: {
    ams: { usd: 0, confidence: 'rough', note: 'AMS campaign cost is bid-driven and user-capped; no cost until clicks accrue. Actual spend set by the campaign daily budget the user configures in AMS.' } as PriceEntry,
    bookfunnel: { usd: 0, confidence: 'rough', note: 'BookFunnel ARC delivery — typically covered by an existing flat subscription, not a per-send cost.' } as PriceEntry,
    esp: { usd: 0, confidence: 'rough', note: 'Email ESP sends — typically covered by an existing flat/tiered subscription, not a per-send cost.' } as PriceEntry,
    bookbub: { usd: 0, confidence: 'rough', note: 'BookBub Featured Deal submission is free; if accepted, BookBub charges a placement fee that varies by genre/list size and is quoted at acceptance.' } as PriceEntry,
    kdp: { usd: 0, confidence: 'listed', note: 'KDP metadata, pre-order setup, and publishing carry no direct cost — Amazon takes a royalty share on sales instead.' } as PriceEntry,
    social: { usd: 0, confidence: 'rough', note: 'Organic social posting — no direct cost (assumes no paid boost).' } as PriceEntry,
    internal: { usd: 0, confidence: 'listed', note: 'Internal drafting/planning step — no external cost.' } as PriceEntry,
    default: { usd: 0, confidence: 'rough', note: 'No specific cost model for this step type yet — treat as a rough placeholder.' } as PriceEntry,
  } as Record<string, PriceEntry>,
};

// ═══════════════════════════════════════════════════════════
// LLM per-model pricing (text completion)
// ═══════════════════════════════════════════════════════════

/**
 * Per-1K-token USD pricing for a single LLM model.
 *
 * `confidence`:
 *   'listed' — taken from the provider's published price sheet
 *              (or the claude-api skill's cached pricing table).
 *   'rough'  — estimate / not authoritatively verified (new models,
 *              future models, unknown custom slugs).
 */
export interface LLMPrice {
  costPer1kInput: number;
  costPer1kOutput: number;
  confidence: CostConfidence;
  /** ISO date this row was last checked against a source. */
  lastVerified: string;
  /** Human-readable note — source, tier, caveats. */
  note: string;
}

/**
 * LLM pricing table, keyed by model id (the exact string sent to the
 * provider). Prices are USD per 1,000 tokens.
 *
 * Sources: Anthropic/OpenAI/Google/DeepSeek published pricing, cross-checked
 * against the claude-api skill's cached model table (2026-06-24). Anthropic
 * per-MTok figures divided by 1000 for the per-1K values here
 * (e.g. Claude Sonnet 4.5 = $3/$15 per MTok = 0.003 / 0.015 per 1K).
 *
 * IMPORTANT: the DEFAULT model for each provider (see router.ts) MUST have a
 * row here whose per-1K numbers exactly match the provider's hardcoded
 * costPer1kInput/Output, so switching pricing to be model-aware does not
 * change cost math for anyone still on the defaults. Guarded by a test.
 */
export const LLM_PRICING: Record<string, LLMPrice> = {
  // ── Anthropic Claude ──
  // Current default provider model. Must match router.ts claude hardcoded (0.003 / 0.015).
  'claude-sonnet-4-5': { costPer1kInput: 0.003, costPer1kOutput: 0.015, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Sonnet 4.5 — $3/$15 per MTok' },
  'claude-sonnet-4-6': { costPer1kInput: 0.003, costPer1kOutput: 0.015, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Sonnet 4.6 — $3/$15 per MTok' },
  'claude-sonnet-5':   { costPer1kInput: 0.003, costPer1kOutput: 0.015, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Sonnet 5 — $3/$15 per MTok (intro $2/$10 through 2026-08-31; standard used here)' },
  'claude-opus-4-5':   { costPer1kInput: 0.005, costPer1kOutput: 0.025, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Opus 4.5 — $5/$25 per MTok' },
  'claude-opus-4-6':   { costPer1kInput: 0.005, costPer1kOutput: 0.025, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Opus 4.6 — $5/$25 per MTok' },
  'claude-opus-4-7':   { costPer1kInput: 0.005, costPer1kOutput: 0.025, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Opus 4.7 — $5/$25 per MTok' },
  'claude-opus-4-8':   { costPer1kInput: 0.005, costPer1kOutput: 0.025, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Opus 4.8 — $5/$25 per MTok' },
  // Claude Fable 5 — Anthropic's most capable widely-released model; pricing
  // ($10/$50 per MTok) exceeds Opus tier. Marked 'rough' per task: it's above
  // the pricing we normally budget against and worth re-verifying before it's
  // used for real cost decisions.
  'claude-fable-5':    { costPer1kInput: 0.010, costPer1kOutput: 0.050, confidence: 'rough', lastVerified: '2026-07-06', note: 'Claude Fable 5 — $10/$50 per MTok (above Opus tier); re-verify before budgeting' },
  'claude-haiku-4-5':  { costPer1kInput: 0.001, costPer1kOutput: 0.005, confidence: 'listed', lastVerified: '2026-07-06', note: 'Claude Haiku 4.5 — $1/$5 per MTok' },

  // ── OpenAI ──
  // Current default provider model. Must match router.ts openai hardcoded (0.0025 / 0.01).
  'gpt-4o':      { costPer1kInput: 0.0025, costPer1kOutput: 0.01,   confidence: 'listed', lastVerified: '2026-07-06', note: 'GPT-4o — $2.50/$10 per MTok' },
  'gpt-4o-mini': { costPer1kInput: 0.00015, costPer1kOutput: 0.0006, confidence: 'listed', lastVerified: '2026-07-06', note: 'GPT-4o mini — $0.15/$0.60 per MTok' },
  // gpt-5 family + o-series — pricing not authoritatively confirmed here; rough.
  'gpt-5':       { costPer1kInput: 0.00125, costPer1kOutput: 0.01,  confidence: 'rough', lastVerified: '2026-07-06', note: 'GPT-5 — rough estimate, re-verify against OpenAI pricing' },
  'gpt-5-mini':  { costPer1kInput: 0.00025, costPer1kOutput: 0.002, confidence: 'rough', lastVerified: '2026-07-06', note: 'GPT-5 mini — rough estimate, re-verify' },
  'o1':          { costPer1kInput: 0.015,  costPer1kOutput: 0.06,   confidence: 'rough', lastVerified: '2026-07-06', note: 'OpenAI o1 — rough estimate, re-verify' },
  'o3':          { costPer1kInput: 0.002,  costPer1kOutput: 0.008,  confidence: 'rough', lastVerified: '2026-07-06', note: 'OpenAI o3 — rough estimate, re-verify' },
  'o4-mini':     { costPer1kInput: 0.0011, costPer1kOutput: 0.0044, confidence: 'rough', lastVerified: '2026-07-06', note: 'OpenAI o4-mini — rough estimate, re-verify' },

  // ── Google Gemini (free tier = $0) ──
  'gemini-2.5-flash': { costPer1kInput: 0, costPer1kOutput: 0, confidence: 'listed', lastVerified: '2026-07-06', note: 'Gemini 2.5 Flash — free tier ($0), rate-limited' },
  'gemini-2.5-pro':   { costPer1kInput: 0, costPer1kOutput: 0, confidence: 'listed', lastVerified: '2026-07-06', note: 'Gemini 2.5 Pro — free tier ($0), rate-limited' },

  // ── DeepSeek ──
  // Current default provider model. Must match router.ts deepseek hardcoded (0.00014 / 0.00028).
  'deepseek-chat':     { costPer1kInput: 0.00014, costPer1kOutput: 0.00028, confidence: 'listed', lastVerified: '2026-07-06', note: 'DeepSeek Chat — $0.14/$0.28 per MTok' },
  'deepseek-reasoner': { costPer1kInput: 0.00055, costPer1kOutput: 0.00219, confidence: 'rough',  lastVerified: '2026-07-06', note: 'DeepSeek Reasoner — rough estimate, re-verify' },
};

/**
 * Resolve per-1K pricing for an LLM model id.
 *
 * Returns the LLM_PRICING row when the model is known. For an unknown model
 * (a custom / future slug the user typed), returns the provided fallback
 * numbers with confidence 'rough' — so cost math keeps working and never
 * throws. Callers pass the provider's current hardcoded default numbers as the
 * fallback so an unknown model at least bills like that provider's default.
 *
 * @param model   The model id (e.g. 'claude-sonnet-4-5', 'gemini-2.5-pro').
 * @param fallback Optional {costPer1kInput, costPer1kOutput} used when the
 *                 model isn't in LLM_PRICING. Defaults to 0/0.
 */
export function getLLMPrice(
  model: string,
  fallback?: { costPer1kInput: number; costPer1kOutput: number },
): LLMPrice {
  const known = LLM_PRICING[model];
  if (known) return known;

  const fb = fallback ?? { costPer1kInput: 0, costPer1kOutput: 0 };
  return {
    costPer1kInput: fb.costPer1kInput,
    costPer1kOutput: fb.costPer1kOutput,
    confidence: 'rough',
    lastVerified: PRICING_LAST_VERIFIED,
    note: `Unknown model "${model}" — using provider fallback pricing; unverified`,
  };
}

/** Look up the OpenAI image price for a given size + quality + model.
 *  `model` defaults to gpt-image-1 pricing; pass 'gpt-image-2' to use the
 *  gpt-image-2 placeholder table (currently mirrors gpt-image-1, 'rough'
 *  confidence — unverified against OpenAI's published pricing). */
export function getOpenAIImagePrice(
  width: number,
  height: number,
  quality: 'low' | 'medium' | 'high' | 'auto' = 'high',
  model?: string,
): number {
  const table = model === 'gpt-image-2' ? (PRICING.image as any)['openai-gpt-image-2'] : PRICING.image.openai;
  const sizeKey = `${width}x${height}` as keyof typeof PRICING.image.openai;
  const base = (table as any)[sizeKey]?.usd ?? table['1024x1536'].usd;
  const mult = table.qualityMultiplier[quality] ?? 1.0;
  return Math.round(base * mult * 100) / 100;
}
