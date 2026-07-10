/**
 * AuthorAgent Amazon Advertising (AMS) Campaign Architect
 *
 * PLANNING + ANALYSIS only. Does not execute bids, launch campaigns, or
 * modify anything in AMS on its own. Every campaign change must pass through
 * the ConfirmationGateService, where the user sees the exact bid, target
 * keywords, and daily budget before approving.
 *
 * What this service does:
 *   - Harvest candidate keywords from comp-title ASINs (via browser automation
 *     orchestrated by the user, not this service — AMS has no public API
 *     for keyword discovery from the Advertising Console)
 *   - Suggest three campaign templates (Sponsored Products, Sponsored Brands,
 *     Category) with recommended initial bids + daily budgets
 *   - Analyze provided performance data (ACoS per keyword, impressions, CTR)
 *     and output structured recommendations: which keywords to pause, which to
 *     expand bids on, which to add as exact-match vs broad
 *   - Enforce a user-configured hard spend cap on any bid-change proposal
 *
 * Note: AuthorAgent never suggests ACoS targets that are obviously predatory
 * (e.g., below 5%) or escalates bids by more than 2x in a single confirmation.
 */

export interface KeywordCandidate {
  keyword: string;
  source: 'comp_title' | 'category' | 'bestseller_tag' | 'manual';
  estimatedRelevance: number;       // 0-1
  suggestedMatchType: 'exact' | 'phrase' | 'broad';
  suggestedBidUSD: number;
  notes?: string;
}

export interface AMSCampaignTemplate {
  type: 'sponsored_products' | 'sponsored_brands' | 'category';
  name: string;
  description: string;
  dailyBudgetUSD: number;
  keywords: KeywordCandidate[];
  targetingExplanation: string;
}

export interface KeywordPerformance {
  keyword: string;
  matchType: 'exact' | 'phrase' | 'broad';
  impressions: number;
  clicks: number;
  spendUSD: number;
  salesUSD: number;
  acos: number;                     // Ad Cost of Sale — spend / sales
  currentBidUSD: number;
}

export interface OptimizationRecommendation {
  keyword: string;
  matchType: 'exact' | 'phrase' | 'broad';
  action: 'pause' | 'increase_bid' | 'decrease_bid' | 'add_negative' | 'promote_to_exact' | 'keep';
  currentBidUSD: number;
  proposedBidUSD: number;
  rationale: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface OptimizationReport {
  generatedAt: string;
  overallACoS: number;
  totalSpendUSD: number;
  totalSalesUSD: number;
  recommendations: OptimizationRecommendation[];
  dryRunSummary: string;
  wouldIncreaseDailySpendBy: number;
  warnings: string[];
}

export class AMSAdsService {
  /**
   * Propose three campaign templates from a base set of keywords + book metadata.
   */
  proposeCampaigns(input: {
    bookTitle: string;
    genre: string;
    keywords: string[];               // Seed list; typically from comp ASINs
    dailyBudgetCeilingUSD: number;   // Hard cap the user set
  }): AMSCampaignTemplate[] {
    const splitBudget = Math.max(1, Math.floor(input.dailyBudgetCeilingUSD / 3));

    const makeCandidates = (kws: string[], matchType: KeywordCandidate['suggestedMatchType'], bid: number): KeywordCandidate[] =>
      kws.map(k => ({
        keyword: k,
        source: 'comp_title',
        estimatedRelevance: 0.7,
        suggestedMatchType: matchType,
        suggestedBidUSD: Math.round(bid * 100) / 100,
      }));

    return [
      {
        type: 'sponsored_products',
        name: `${input.bookTitle} — SP Broad`,
        description: 'Broad-match Sponsored Products campaign for discovery. Expect low relevance initially; optimize aggressively after 14 days.',
        dailyBudgetUSD: splitBudget,
        keywords: makeCandidates(input.keywords.slice(0, 30), 'broad', 0.45),
        targetingExplanation: 'Broad match captures related phrases. Starting bid is the genre median; adjust after first-week data.',
      },
      {
        type: 'sponsored_products',
        name: `${input.bookTitle} — SP Exact`,
        description: 'Exact-match for known winners. Use the top 10-15 highest-relevance comp-title keywords only.',
        dailyBudgetUSD: splitBudget,
        keywords: makeCandidates(input.keywords.slice(0, 15), 'exact', 0.75),
        targetingExplanation: 'Exact match is precise and usually profitable. Start with a higher bid since impressions are narrow.',
      },
      {
        type: 'category',
        name: `${input.bookTitle} — ${input.genre} Category`,
        description: `Target Amazon\'s ${input.genre} category as a whole. Useful for reach when your book is new and organic ranking is low.`,
        dailyBudgetUSD: splitBudget,
        keywords: [],
        targetingExplanation: 'Category-targeted ads compete with the top sellers in the category. Lower CTR but high visibility.',
      },
    ];
  }

  /**
   * Analyze provided AMS performance data (pasted from Amazon Advertising UI
   * export) and produce optimization recommendations.
   *
   * Never proposes a bid increase > 2x the current bid. Never proposes a bid
   * on a keyword with ACoS > 100% unless clicks < 5 (too little data).
   */
  optimize(input: {
    performance: KeywordPerformance[];
    acosTargetPct: number;            // e.g., 30 means 30% target
    dailyBudgetCeilingUSD: number;    // Global cap across all proposed changes
    currentDailySpendUSD: number;
  }): OptimizationReport {
    const recommendations: OptimizationRecommendation[] = [];
    const warnings: string[] = [];
    const totalSpend = input.performance.reduce((s, p) => s + p.spendUSD, 0);
    const totalSales = input.performance.reduce((s, p) => s + p.salesUSD, 0);
    const overallACoS = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
    let budgetDelta = 0;

    for (const p of input.performance) {
      const acosPct = p.acos * 100;

      // No data yet — keep.
      if (p.clicks < 5) {
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: 'keep',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: p.currentBidUSD,
          rationale: `Not enough data (${p.clicks} clicks). Keep the current bid for at least 7 more days before deciding.`,
          riskLevel: 'low',
        });
        continue;
      }

      // Zero sales + meaningful spend → pause.
      if (p.salesUSD === 0 && p.spendUSD >= 3) {
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: 'pause',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: 0,
          rationale: `Spent $${p.spendUSD.toFixed(2)} with no sales across ${p.clicks} clicks. Pause and add as a negative keyword.`,
          riskLevel: 'low',
        });
        budgetDelta -= p.spendUSD / 30;  // Approximate monthly → daily
        continue;
      }

      // High ACoS → cut bid or pause.
      if (acosPct > 100) {
        const newBid = Math.max(0.02, p.currentBidUSD * 0.5);
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: p.clicks > 20 ? 'pause' : 'decrease_bid',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: newBid,
          rationale: `ACoS ${acosPct.toFixed(0)}% is unsustainable. ${p.clicks > 20 ? 'Pause this keyword.' : `Cut bid 50% to $${newBid.toFixed(2)}.`}`,
          riskLevel: 'low',
        });
        continue;
      }

      // ACoS above target — slight bid cut.
      if (acosPct > input.acosTargetPct * 1.3) {
        const newBid = Math.max(0.02, p.currentBidUSD * 0.8);
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: 'decrease_bid',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: newBid,
          rationale: `ACoS ${acosPct.toFixed(0)}% is above target (${input.acosTargetPct}%). Trim bid 20%.`,
          riskLevel: 'low',
        });
        continue;
      }

      // ACoS well below target and getting sales → scale up (max 2x cap).
      if (acosPct < input.acosTargetPct * 0.5 && p.salesUSD > 0) {
        const proposed = Math.min(p.currentBidUSD * 2, p.currentBidUSD * 1.5);
        const newBid = Math.round(proposed * 100) / 100;
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: 'increase_bid',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: newBid,
          rationale: `Profitable at ${acosPct.toFixed(0)}% ACoS. Scale bid 50% to capture more impressions.`,
          riskLevel: 'medium',
        });
        budgetDelta += (newBid - p.currentBidUSD) * Math.max(1, p.clicks / 30);
        continue;
      }

      // Broad-match winners → promote to exact.
      if (p.matchType === 'broad' && acosPct < input.acosTargetPct && p.clicks >= 30) {
        recommendations.push({
          keyword: p.keyword, matchType: p.matchType, action: 'promote_to_exact',
          currentBidUSD: p.currentBidUSD, proposedBidUSD: p.currentBidUSD * 1.1,
          rationale: `Broad-match winner (${p.clicks} clicks, ${acosPct.toFixed(0)}% ACoS). Add as exact match at a slightly higher bid.`,
          riskLevel: 'low',
        });
        continue;
      }

      // Hold.
      recommendations.push({
        keyword: p.keyword, matchType: p.matchType, action: 'keep',
        currentBidUSD: p.currentBidUSD, proposedBidUSD: p.currentBidUSD,
        rationale: `Performance in target band — keep.`,
        riskLevel: 'low',
      });
    }

    // Budget-delta sanity check.
    const proposedDaily = input.currentDailySpendUSD + budgetDelta;
    if (proposedDaily > input.dailyBudgetCeilingUSD) {
      warnings.push(
        `Proposed changes would raise daily spend to ~$${proposedDaily.toFixed(2)}, ` +
        `exceeding your ceiling of $${input.dailyBudgetCeilingUSD.toFixed(2)}. ` +
        `Scaling bid-increase proposals back before recommending execution.`
      );
      // Roll back bid increases to stay under the cap.
      for (const rec of recommendations) {
        if (rec.action === 'increase_bid') {
          rec.action = 'keep';
          rec.proposedBidUSD = rec.currentBidUSD;
          rec.rationale = `Bid increase suppressed — would exceed daily budget ceiling.`;
        }
      }
    }

    const dryRunSummary = this.formatDryRun(recommendations, overallACoS, totalSpend, totalSales);

    return {
      generatedAt: new Date().toISOString(),
      overallACoS: Math.round(overallACoS * 10) / 10,
      totalSpendUSD: Math.round(totalSpend * 100) / 100,
      totalSalesUSD: Math.round(totalSales * 100) / 100,
      recommendations,
      dryRunSummary,
      wouldIncreaseDailySpendBy: Math.max(0, Math.round(budgetDelta * 100) / 100),
      warnings,
    };
  }

  private formatDryRun(recs: OptimizationRecommendation[], acos: number, spend: number, sales: number): string {
    const grouped = {
      pause: recs.filter(r => r.action === 'pause'),
      decrease: recs.filter(r => r.action === 'decrease_bid'),
      increase: recs.filter(r => r.action === 'increase_bid'),
      promote: recs.filter(r => r.action === 'promote_to_exact'),
      keep: recs.filter(r => r.action === 'keep'),
    };
    const lines: string[] = [
      `Overall ACoS: ${acos.toFixed(1)}% ($${spend.toFixed(2)} spend / $${sales.toFixed(2)} sales)`,
      `Pausing ${grouped.pause.length} keywords | Cutting bids on ${grouped.decrease.length} | Raising ${grouped.increase.length} | Promoting ${grouped.promote.length} | Keeping ${grouped.keep.length}`,
    ];
    if (grouped.pause.length > 0) lines.push(`Top pauses: ${grouped.pause.slice(0, 5).map(r => r.keyword).join(', ')}`);
    if (grouped.increase.length > 0) lines.push(`Top raises: ${grouped.increase.slice(0, 5).map(r => `${r.keyword} ($${r.currentBidUSD}→$${r.proposedBidUSD})`).join(', ')}`);
    return lines.join('\n');
  }
}
