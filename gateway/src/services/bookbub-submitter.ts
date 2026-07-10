/**
 * AuthorAgent BookBub Featured Deal Submission Optimizer
 *
 * Builds an optimized Featured Deal submission: BookBub-specific blurb
 * variant, why-this-time rationale, pricing + territory + genre selection.
 * Does NOT submit on its own — produces the complete draft that the user
 * reviews and pastes into the partners.bookbub.com form manually, or
 * approves for submission via a confirmation-gated browser flow.
 *
 * Critical safety rail: this service never fabricates editorial review
 * quotes. If the author wants to include review snippets, they must
 * provide verified ones — we clearly mark which outlets they still need
 * to pitch themselves.
 */

export interface BookBubDraft {
  title: string;
  authorName: string;
  genre: string;
  subgenre?: string;
  blurb: string;                    // BookBub-specific (150-300 words, editorial tone)
  amazonDescription?: string;       // For comparison — NOT what BookBub sees
  suggestedDealPriceUSD: number;    // 0.99 / 1.99 / 2.99 only
  priorDealHistoryNote: string;     // "First deal" or "Last deal: Date, Price"
  territoryPreferences: Array<'US' | 'UK' | 'CA' | 'AU' | 'IN'>;
  whyThisTime: string;              // Rationale for why this submission will convert
  compTitles: string[];             // Recent BookBub Featured Deal titles in same genre
  reviewSnippets: Array<{ quote: string; outlet: string; verified: boolean }>;
  pitchingNeeded: string[];         // Outlets the author still needs to get quotes from
  warnings: string[];
}

export class BookBubSubmitterService {
  private readonly BOOKBUB_PRICE_POINTS = [0.99, 1.99, 2.99];
  private readonly BLURB_MIN = 150;
  private readonly BLURB_MAX = 300;

  /**
   * Build a full submission draft.
   * The caller provides the basic info; this assembles the complete
   * BookBub-style blurb + rationale structure.
   */
  buildDraft(input: {
    title: string;
    authorName: string;
    genre: string;
    subgenre?: string;
    amazonBlurb: string;
    suggestedPriceUSD?: number;
    priorDeals?: Array<{ date: string; priceUSD: number }>;
    reviewSnippets?: Array<{ quote: string; outlet: string; verified: boolean }>;
  }): BookBubDraft {
    const warnings: string[] = [];

    // Normalize deal price to a BookBub-accepted point.
    const suggestedDealPriceUSD = this.BOOKBUB_PRICE_POINTS.includes(input.suggestedPriceUSD ?? 0.99)
      ? input.suggestedPriceUSD!
      : 0.99;

    // Convert the Amazon blurb into a BookBub-style blurb.
    // BookBub editors prefer: third-person voice, reader-benefit framing,
    // tighter word count, no all-caps, no rhetorical questions.
    const bookbubBlurb = this.reformatBlurb(input.amazonBlurb, warnings);

    // Prior deal history — first-time, multiple-deal, or cooldown check.
    const priorDealHistoryNote = this.summarizeDealHistory(input.priorDeals, warnings);

    // Why-this-time rationale.
    const whyThisTime = this.composeRationale(input, warnings);

    // Comp titles — user must fill these in; we provide a template.
    const compTitles: string[] = [];
    warnings.push(`Add 3-5 comparable recent BookBub Featured Deals in ${input.genre}. Check https://partners.bookbub.com/featured-deals for recent winners.`);

    // Review snippets — pass-through with verification flags.
    const reviewSnippets = (input.reviewSnippets || [])
      .filter(s => typeof s.quote === 'string' && s.quote.length >= 10)
      .map(s => ({ ...s, verified: !!s.verified }));

    // Outlets to pitch — BookBub values quotes from specific trade publications.
    const pitchingNeeded: string[] = [];
    const haveOutlets = new Set(reviewSnippets.map(s => s.outlet.toLowerCase()));
    for (const outlet of ['Kirkus Reviews', 'Publishers Weekly', 'Booklist', 'Library Journal', 'Foreword Reviews']) {
      if (!haveOutlets.has(outlet.toLowerCase())) {
        pitchingNeeded.push(outlet);
      }
    }

    if (reviewSnippets.some(s => !s.verified)) {
      warnings.push('Unverified review snippets included. BookBub requires verifiable editorial reviews — do NOT submit fabricated quotes.');
    }

    return {
      title: input.title,
      authorName: input.authorName,
      genre: input.genre,
      subgenre: input.subgenre,
      blurb: bookbubBlurb,
      amazonDescription: input.amazonBlurb,
      suggestedDealPriceUSD,
      priorDealHistoryNote,
      territoryPreferences: ['US', 'UK', 'CA', 'AU', 'IN'],
      whyThisTime,
      compTitles,
      reviewSnippets,
      pitchingNeeded,
      warnings,
    };
  }

  private reformatBlurb(amazonBlurb: string, warnings: string[]): string {
    let blurb = (amazonBlurb || '').replace(/\s+/g, ' ').trim();

    // Strip HTML that Amazon uses but BookBub rejects.
    blurb = blurb.replace(/<[^>]+>/g, '');

    // Convert all-caps words to title case.
    blurb = blurb.replace(/\b[A-Z]{4,}\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase());

    // Remove exclamation-packed lines (BookBub editors find this amateurish).
    blurb = blurb.replace(/!{2,}/g, '.');
    blurb = blurb.replace(/!/g, '.');

    // Word-count check.
    const words = blurb.split(/\s+/).filter(Boolean);
    if (words.length < this.BLURB_MIN) {
      warnings.push(`Blurb is only ${words.length} words; BookBub prefers ${this.BLURB_MIN}–${this.BLURB_MAX}.`);
    } else if (words.length > this.BLURB_MAX) {
      // Trim to approx max.
      blurb = words.slice(0, this.BLURB_MAX).join(' ') + '…';
      warnings.push(`Blurb was longer than ${this.BLURB_MAX} words; truncated. Review the cut for narrative flow.`);
    }

    return blurb;
  }

  private summarizeDealHistory(prior: Array<{ date: string; priceUSD: number }> | undefined, warnings: string[]): string {
    if (!prior || prior.length === 0) return 'First BookBub Featured Deal submission for this title.';
    const sorted = [...prior].sort((a, b) => b.date.localeCompare(a.date));
    const lastDeal = sorted[0];
    const monthsSince = Math.floor((Date.now() - new Date(lastDeal.date).getTime()) / (30 * 86400000));
    if (monthsSince < 6) {
      warnings.push(`Last deal was only ${monthsSince} months ago. BookBub typically requires 6+ months between deals on the same title.`);
    }
    return `Prior deals: ${sorted.length}. Most recent: ${lastDeal.date} at $${lastDeal.priceUSD.toFixed(2)}.`;
  }

  private composeRationale(input: { title: string; authorName: string; genre: string; suggestedPriceUSD?: number }, _warnings: string[]): string {
    return [
      `${input.title} is a ${input.genre} title by ${input.authorName}.`,
      `This submission targets BookBub readers who have shown strong interest in ${input.genre}.`,
      `The suggested deal price of $${(input.suggestedPriceUSD ?? 0.99).toFixed(2)} is aggressive but aligns with BookBub's known conversion sweet spot for first-in-series and discovery buys.`,
      `(Author: expand with specifics — awards, Amazon rank, reader reviews, any recent press. Be concrete.)`,
    ].join(' ');
  }
}
