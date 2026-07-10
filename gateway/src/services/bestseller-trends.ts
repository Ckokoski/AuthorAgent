/**
 * AuthorAgent Bestseller Trends Provider (PLACEHOLDER)
 *
 * This is the integration point for a forthcoming PAID data API — Chris's
 * own book-market data product ("Bestseller Trends"). The real API is not
 * built yet. This file exists so:
 *   1. Comp-title lookup, market-fit scoring, and synthetic-reader-panel
 *      features have a single, obvious place to plug the real thing in.
 *   2. The integration surface (types + method signatures) is locked down
 *      now, giving the future API build a concrete contract to match.
 *   3. Every caller already works TODAY, for free, without the API —
 *      graceful degradation is not an afterthought bolted on later.
 *
 * Cost-efficiency / graceful-degradation convention (matches
 * research-lookup.ts, pricing.ts, etc. elsewhere in gateway/src/services):
 *   - Features must work with NO configuration — free heuristics / LLM
 *     judgment / existing services (e.g. research-lookup.ts) fill the gap.
 *   - Features get BETTER when this provider is configured (real sales
 *     rank, real comp titles, real trend data) — never required.
 *   - Never throw when unconfigured. Always return a typed, clearly-marked
 *     "unconfigured" result so callers can branch on it (e.g. show a
 *     "connect Bestseller Trends for sharper comps" upsell hint in the UI).
 *
 * How a feature should call this:
 *
 *   const trends = new BestsellerTrendsProvider(await loadConfig());
 *   const status = trends.getStatus();
 *   const comps = await trends.getCompTitles({ genre: 'cozy fantasy', tropes: ['found family'] });
 *   if (comps.source === 'unconfigured') {
 *     // fall back to research-lookup.ts / existing LLM-based comp reasoning
 *   } else {
 *     // use comps.items directly — real market data
 *   }
 *
 * TODO (real API build): replace the stub bodies below with actual fetch()
 * calls once the Bestseller Trends API is live. See per-method TODOs for the
 * intended request/response contract.
 */

// ═══════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════

export type BestsellerTrendsTier = 'free' | 'basic' | 'pro' | 'enterprise';

export interface BestsellerTrendsConfig {
  /** Base URL of the Bestseller Trends API, e.g. 'https://api.bestsellertrends.dev/v1'. */
  apiBaseUrl?: string;
  /** API key issued to the author's account. Sourced from Vault in production
   *  (see research-lookup.ts / image-gen.ts for the `vault.get(...)` pattern) —
   *  this class itself stays storage-agnostic and just accepts the resolved value. */
  apiKey?: string;
  /** Subscription tier — gates which endpoints/fields are available server-side. */
  tier: BestsellerTrendsTier;
  /** Explicit kill switch independent of whether credentials are present. */
  enabled: boolean;
}

/** Safe default: fully unconfigured, free tier, disabled. Every feature must
 *  behave correctly when constructed with nothing but this default. */
export const DEFAULT_BESTSELLER_TRENDS_CONFIG: BestsellerTrendsConfig = {
  apiBaseUrl: undefined,
  apiKey: undefined,
  tier: 'free',
  enabled: false,
};

// ═══════════════════════════════════════════════════════════
// Types — shaped to match the intended real-API response contract
// ═══════════════════════════════════════════════════════════

export interface CompTitle {
  title: string;
  author: string;
  /** Category/bestseller-list rank at time of snapshot, if applicable. */
  rank?: number;
  /** Estimated sales (rough order-of-magnitude; real API should provide a range or confidence band). */
  estSales?: number;
  price?: number;
  categories: string[];
  publishedDate?: string;             // ISO date
  /** Why this title was surfaced as a comp — trope/keyword/genre overlap signal. */
  matchReason?: string;
  /** 0-1 relevance score for the query that produced this result. */
  relevanceScore?: number;
}

export interface TrendSnapshot {
  category: string;
  /** Reporting window this snapshot covers, e.g. '7d', '30d', '90d'. */
  window: string;
  asOf: string;                       // ISO date the snapshot was generated
  /** Tropes/keywords trending up in this category, ranked. */
  risingTropes: string[];
  /** Tropes/keywords cooling off in this category, ranked. */
  decliningTropes: string[];
  /** Representative titles driving the trend (subset of CompTitle shape). */
  topTitles: CompTitle[];
  /** Rough average price point observed in-category for the window. */
  avgPrice?: number;
}

/** Small typed wrapper so every list-returning method can signal provenance
 *  without callers having to guess from an empty array whether that means
 *  "no results" or "not configured at all". */
export interface ProviderResult<T> {
  items: T[];
  source: 'unconfigured' | 'live' | 'error';
  /** Present when source === 'error' or 'unconfigured', for logging/UI. */
  message?: string;
}

export interface MarketFitScore {
  /** 0-100 neutral-scaled score. Unconfigured mode returns a fixed neutral midpoint. */
  score: number;
  /** 'none' when unconfigured (no real signal backing the number), otherwise
   *  a rough qualitative confidence band from the real API. */
  confidence: 'none' | 'low' | 'medium' | 'high';
  source: 'unconfigured' | 'live' | 'error';
  message?: string;
}

export interface BestsellerTrendsStatus {
  configured: boolean;
  tier: BestsellerTrendsTier;
  message: string;
}

// ═══════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════

export class BestsellerTrendsProvider {
  private config: BestsellerTrendsConfig;

  constructor(config: Partial<BestsellerTrendsConfig> = {}) {
    this.config = { ...DEFAULT_BESTSELLER_TRENDS_CONFIG, ...config };
  }

  /** Whether we have enough to attempt a live call. Does not guarantee the
   *  key is valid — just that it's worth trying. */
  private isConfigured(): boolean {
    return Boolean(this.config.enabled && this.config.apiBaseUrl && this.config.apiKey);
  }

  /**
   * Cheap synchronous status check — features can call this to decide
   * whether to show an upsell ("connect Bestseller Trends for real comps")
   * without awaiting a network call.
   */
  getStatus(): BestsellerTrendsStatus {
    if (!this.isConfigured()) {
      return {
        configured: false,
        tier: this.config.tier,
        message: 'not configured — using free heuristics',
      };
    }
    return {
      configured: true,
      tier: this.config.tier,
      message: `connected (${this.config.tier} tier)`,
    };
  }

  /**
   * Comp-title lookup for a genre/keyword/trope combination.
   *
   * Unconfigured: returns an empty result set marked `source: 'unconfigured'`.
   * Callers should fall back to existing free paths (e.g.
   * research-lookup.ts's findCompAuthors(), or direct LLM reasoning) rather
   * than treating an empty array as "no comps exist".
   *
   * TODO (real API contract):
   *   GET {apiBaseUrl}/v1/comp-titles
   *   Headers: { Authorization: `Bearer ${apiKey}` }
   *   Query params: { genre, keywords?: string[] (csv), tropes?: string[] (csv), limit? }
   *   Tier gating: 'free' tier → top 3 comps, no estSales field;
   *                'basic'/'pro' → full CompTitle shape;
   *                'enterprise' → adds historical rank trend (out of scope for this type).
   *   Response: { items: CompTitle[] }
   */
  async getCompTitles(query: { genre: string; keywords?: string[]; tropes?: string[] }): Promise<ProviderResult<CompTitle>> {
    if (!this.isConfigured()) {
      return {
        items: [],
        source: 'unconfigured',
        message: 'Bestseller Trends not configured — using free heuristics (e.g. research-lookup.ts findCompAuthors) for comp titles.',
      };
    }

    // TODO: replace with a real fetch() once the API exists, e.g.:
    //
    // const params = new URLSearchParams({ genre: query.genre });
    // if (query.keywords?.length) params.set('keywords', query.keywords.join(','));
    // if (query.tropes?.length) params.set('tropes', query.tropes.join(','));
    // const res = await fetch(`${this.config.apiBaseUrl}/v1/comp-titles?${params}`, {
    //   headers: { Authorization: `Bearer ${this.config.apiKey}` },
    // });
    // if (!res.ok) { ... return { items: [], source: 'error', message: ... } }
    // const data = await res.json();
    // return { items: data.items, source: 'live' };

    console.warn('  [bestseller-trends] getCompTitles() called while "configured" but no live implementation exists yet (placeholder provider).');
    return {
      items: [],
      source: 'error',
      message: 'Bestseller Trends API integration not yet implemented — this is a placeholder provider.',
    };
  }

  /**
   * Category trend snapshot (rising/declining tropes, top titles, price band).
   *
   * Unconfigured: returns an empty result set marked `source: 'unconfigured'`.
   *
   * TODO (real API contract):
   *   GET {apiBaseUrl}/v1/trends
   *   Headers: { Authorization: `Bearer ${apiKey}` }
   *   Query params: { category, window?: '7d' | '30d' | '90d' (default '30d') }
   *   Tier gating: 'free' → 7d window only, no topTitles;
   *                'basic' → 30d window, top 5 topTitles;
   *                'pro'/'enterprise' → all windows, top 20 topTitles, avgPrice.
   *   Response: { items: TrendSnapshot[] }
   */
  async getTrends(query: { category: string; window?: '7d' | '30d' | '90d' }): Promise<ProviderResult<TrendSnapshot>> {
    if (!this.isConfigured()) {
      return {
        items: [],
        source: 'unconfigured',
        message: 'Bestseller Trends not configured — trend data unavailable; consider research-lookup.ts for a manual/LLM-assisted market scan instead.',
      };
    }

    // TODO: replace with a real fetch() once the API exists, e.g.:
    //
    // const params = new URLSearchParams({ category: query.category, window: query.window ?? '30d' });
    // const res = await fetch(`${this.config.apiBaseUrl}/v1/trends?${params}`, {
    //   headers: { Authorization: `Bearer ${this.config.apiKey}` },
    // });
    // if (!res.ok) { ... return { items: [], source: 'error', message: ... } }
    // const data = await res.json();
    // return { items: data.items, source: 'live' };

    console.warn('  [bestseller-trends] getTrends() called while "configured" but no live implementation exists yet (placeholder provider).');
    return {
      items: [],
      source: 'error',
      message: 'Bestseller Trends API integration not yet implemented — this is a placeholder provider.',
    };
  }

  /**
   * Market-fit score for a synopsis in a given genre — feeds the
   * synthetic-reader-panel / market-fit features.
   *
   * Unconfigured: returns a neutral midpoint score (50) with confidence
   * 'none' so callers never mistake this for a real signal. Features should
   * treat confidence 'none' as "ask the LLM synthetic-reader-panel instead
   * of trusting this number".
   *
   * TODO (real API contract):
   *   POST {apiBaseUrl}/v1/market-fit
   *   Headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
   *   Body: { synopsis: string, genre: string }
   *   Tier gating: 'free' → not available (403); 'basic' → score + confidence only;
   *                'pro'/'enterprise' → adds contributing-factors breakdown (future field).
   *   Response: { score: number (0-100), confidence: 'low'|'medium'|'high' }
   */
  async getMarketFitScore(input: { synopsis: string; genre: string }): Promise<MarketFitScore> {
    if (!this.isConfigured()) {
      return {
        score: 50,
        confidence: 'none',
        source: 'unconfigured',
        message: 'Bestseller Trends not configured — neutral score returned; use the LLM synthetic-reader-panel for a real assessment.',
      };
    }

    // TODO: replace with a real fetch() once the API exists, e.g.:
    //
    // const res = await fetch(`${this.config.apiBaseUrl}/v1/market-fit`, {
    //   method: 'POST',
    //   headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ synopsis: input.synopsis, genre: input.genre }),
    // });
    // if (!res.ok) { ... return { score: 50, confidence: 'none', source: 'error', message: ... } }
    // const data = await res.json();
    // return { score: data.score, confidence: data.confidence, source: 'live' };

    console.warn('  [bestseller-trends] getMarketFitScore() called while "configured" but no live implementation exists yet (placeholder provider).');
    return {
      score: 50,
      confidence: 'none',
      source: 'error',
      message: 'Bestseller Trends API integration not yet implemented — this is a placeholder provider.',
    };
  }
}
