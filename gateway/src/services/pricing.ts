/**
 * AuthorClaw Central Pricing Table
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
