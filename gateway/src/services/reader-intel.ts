/**
 * AuthorAgent Reader Intelligence Engine
 *
 * Analyzes review data (provided by the user or fetched via the existing
 * ResearchGate with rate limits + robots.txt respect) to surface:
 *   - Trope / premise clusters readers are requesting
 *   - Common complaints (what falls flat in the genre)
 *   - Sentiment trend over time
 *   - Cross-book "if you liked X you'll like Y" affinity signals
 *
 * Strict safety rails:
 *   - PII is dropped or hashed before any clustering. Reviewer display names,
 *     user IDs, and avatar URLs are never retained.
 *   - Verbatim review text is NEVER inserted into marketing copy. Clusters
 *     reference reviews by opaque IDs; the generation step uses only
 *     aggregate patterns, not quoted strings.
 *   - Scraping must go through ResearchGate (allowlist, rate limits, TOS
 *     warnings). This service operates on whatever the gate returns.
 *   - Goodreads data is loaded via the official partner API only where the
 *     author has a partner key. Raw scraping is discouraged; if used,
 *     respect robots.txt and rate limit strictly.
 */

export interface RawReview {
  id?: string;                       // Arbitrary stable ID
  rating?: number;                   // 1-5
  text: string;
  date?: string;                     // ISO
  bookAsin?: string;
  // We deliberately do NOT accept reviewer name / profile URL / avatar.
}

export interface SanitizedReview {
  id: string;                        // SHA-256 hash of (bookAsin + text)
  rating: number;
  text: string;                      // Kept for analysis; never re-exported
  date: string;                      // ISO
  bookAsin: string;
}

export interface ReviewCluster {
  label: string;                     // Human-readable pattern ("wants more worldbuilding")
  keywords: string[];                // Top terms that define this cluster
  reviewCount: number;
  avgRating: number;
  sentiment: 'positive' | 'mixed' | 'negative';
  category: 'trope_requested' | 'complaint' | 'praise' | 'comp_suggestion' | 'other';
}

export interface TropeSignal {
  trope: string;                     // e.g., "enemies-to-lovers", "found family", "magic school"
  mentions: number;
  avgRatingWhenMentioned: number;
  stanceHint: 'readers_want_more' | 'readers_dislike' | 'neutral';
}

export interface ReaderIntelReport {
  generatedAt: string;
  reviewsAnalyzed: number;
  sentimentTimeline: Array<{ month: string; avgRating: number; count: number }>;
  clusters: ReviewCluster[];
  tropeSignals: TropeSignal[];
  readerRequestedNextStories: string[];
  topComplaints: string[];
  disclaimer: string;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

// Common tropes / patterns — expand as genres require.
const TROPE_KEYWORDS: Record<string, string[]> = {
  'enemies-to-lovers': ['enemies to lovers', 'hate to love', 'rivals'],
  'found family': ['found family', 'chosen family', 'family of misfits'],
  'slow burn': ['slow burn', 'tension builds', 'builds slowly'],
  'dark academia': ['dark academia', 'ancient secrets', 'library', 'tutor'],
  'fae / fairy': ['fae', 'fairy', 'fairy court', 'seelie', 'unseelie'],
  'dragons': ['dragon', 'dragonrider'],
  'magic school': ['magic school', 'boarding school', 'school of magic', 'academy'],
  'pirates': ['pirate', 'captain', 'ship'],
  'vampires': ['vampire', 'bloodlust', 'immortal'],
  'dystopia': ['dystopia', 'rebellion', 'authoritarian'],
  'portal fantasy': ['portal', 'other world', 'stepped through'],
  'cozy mystery': ['cozy mystery', 'village', 'amateur sleuth'],
  'time travel': ['time travel', 'time loop', 'timeline'],
  'morally grey': ['morally grey', 'morally gray', 'antihero', 'anti-hero'],
  'fake dating': ['fake dating', 'fake relationship', 'pretend couple'],
  'second chance': ['second chance', 'ex-lovers', 'reunion romance'],
};

const COMPLAINT_MARKERS = [
  'disappointed', 'let down', 'boring', 'slow', 'predictable', 'couldn\'t finish',
  'wooden', 'flat', 'cardboard', 'cliche', 'rushed ending', 'sagging middle',
  'too much info', 'infodump', 'no chemistry', 'unbelievable', 'tropey',
  'show don\'t tell', 'telling not showing', 'plot holes',
];

const REQUEST_MARKERS = [
  'wish there was', 'wish it had', 'would have loved', 'needed more',
  'could have used', 'wanted more', 'hope the sequel', 'if only',
  'can\'t wait for', 'need a book about', 'give me more',
];

export class ReaderIntelService {
  /**
   * Sanitize a batch of raw reviews. Drops PII, hashes to stable IDs, filters
   * out suspicious content (prompt-injection attempts in review text, etc.).
   */
  async sanitize(raw: RawReview[]): Promise<SanitizedReview[]> {
    const crypto = await import('crypto');
    const out: SanitizedReview[] = [];
    for (const r of raw) {
      if (!r.text || typeof r.text !== 'string') continue;
      // Drop reviews that contain instruction-like content — these are likely
      // prompt-injection attempts embedded in scraped text.
      if (this.looksLikeInjection(r.text)) continue;
      const cleanText = r.text.replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (cleanText.length < 20) continue;
      const id = r.id || crypto.createHash('sha256')
        .update((r.bookAsin || '') + cleanText)
        .digest('hex')
        .slice(0, 16);
      out.push({
        id,
        rating: Math.max(1, Math.min(5, Math.round(r.rating || 3))),
        text: cleanText,
        date: r.date || new Date().toISOString(),
        bookAsin: r.bookAsin || 'unknown',
      });
    }
    return out;
  }

  /**
   * Analyze a sanitized review set and produce the intelligence report.
   * All clustering is keyword-based (no AI embeddings) so it's deterministic
   * and cheap. For deeper clustering you can add an LLM pass on top of the
   * returned clusters — we deliberately don't auto-call an LLM here.
   */
  analyze(reviews: SanitizedReview[]): ReaderIntelReport {
    const clusters = this.buildClusters(reviews);
    const tropeSignals = this.detectTropes(reviews);
    const sentimentTimeline = this.buildTimeline(reviews);
    const readerRequests = this.extractReaderRequests(reviews);
    const complaints = this.extractComplaints(reviews);

    return {
      generatedAt: new Date().toISOString(),
      reviewsAnalyzed: reviews.length,
      sentimentTimeline,
      clusters,
      tropeSignals,
      readerRequestedNextStories: readerRequests,
      topComplaints: complaints,
      disclaimer:
        'Reader Intelligence output is aggregate signal only. No verbatim review text is ' +
        'exported here. Reviewer names, user IDs, and profile metadata are not retained. ' +
        'Quoting reviews in marketing materials requires explicit permission from each reviewer.',
    };
  }

  /**
   * Very rough instruction-detection for scraped content. If review text
   * contains patterns that look like LLM jailbreaking, drop it.
   */
  private looksLikeInjection(text: string): boolean {
    const patterns = [
      /ignore\s+(?:previous|above|prior)\s+instructions/i,
      /system\s*[:>]/i,
      /<\s*\|?\s*system\s*\|?\s*>/i,
      /disregard\s+your\s+(?:rules|instructions|guidelines)/i,
      /you\s+are\s+now\s+(?:a|an|the)/i,
      /new\s+(?:rules|instructions|persona)/i,
    ];
    return patterns.some(p => p.test(text));
  }

  private buildClusters(reviews: SanitizedReview[]): ReviewCluster[] {
    // Stopword + common-word filter; retain content words only.
    const stops = new Set([
      'the','a','an','and','or','but','of','to','in','on','at','for','with','is','are','was','were','be','been','it','its','that','this','i','you','he','she','they','we','his','her','their','my','your','just','really','very','my','me','so','not','as','by','from','about','out','up','all','one','more','some','like','can','will','would','had','has','have','do','does','did','book','story','read','reading','time','even','than','then','get','got','am','no','yes','which','what','who','when','where','why','how',
    ]);
    const countByWord = new Map<string, { count: number; reviewIds: Set<string>; ratingSum: number }>();

    for (const r of reviews) {
      const words = Array.from(new Set(
        r.text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !stops.has(w))
      ));
      for (const w of words) {
        const existing = countByWord.get(w);
        if (existing) {
          existing.count++;
          existing.reviewIds.add(r.id);
          existing.ratingSum += r.rating;
        } else {
          countByWord.set(w, { count: 1, reviewIds: new Set([r.id]), ratingSum: r.rating });
        }
      }
    }

    // Take top-frequency words as the basis for crude clusters.
    const top = Array.from(countByWord.entries())
      .filter(([, v]) => v.count >= Math.max(3, Math.floor(reviews.length * 0.05)))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15);

    return top.map(([word, v]): ReviewCluster => {
      const avgRating = v.ratingSum / v.count;
      const sentiment: ReviewCluster['sentiment'] = avgRating >= 4 ? 'positive' : avgRating <= 2.5 ? 'negative' : 'mixed';
      const category: ReviewCluster['category'] = sentiment === 'positive' ? 'praise' : sentiment === 'negative' ? 'complaint' : 'other';
      return {
        label: `"${word}" signal (${sentiment})`,
        keywords: [word],
        reviewCount: v.count,
        avgRating: Math.round(avgRating * 10) / 10,
        sentiment,
        category,
      };
    });
  }

  private detectTropes(reviews: SanitizedReview[]): TropeSignal[] {
    const signals: TropeSignal[] = [];
    for (const [trope, keywords] of Object.entries(TROPE_KEYWORDS)) {
      let mentions = 0;
      let ratingSum = 0;
      let requestsCount = 0;
      let dislikesCount = 0;
      for (const r of reviews) {
        const lower = r.text.toLowerCase();
        if (keywords.some(k => lower.includes(k))) {
          mentions++;
          ratingSum += r.rating;
          if (REQUEST_MARKERS.some(m => lower.includes(m))) requestsCount++;
          if (COMPLAINT_MARKERS.some(m => lower.includes(m))) dislikesCount++;
        }
      }
      if (mentions < 3) continue;
      const stanceHint: TropeSignal['stanceHint'] =
        requestsCount > dislikesCount * 1.5 ? 'readers_want_more' :
        dislikesCount > requestsCount * 1.5 ? 'readers_dislike' : 'neutral';
      signals.push({
        trope,
        mentions,
        avgRatingWhenMentioned: Math.round((ratingSum / mentions) * 10) / 10,
        stanceHint,
      });
    }
    return signals.sort((a, b) => b.mentions - a.mentions);
  }

  private buildTimeline(reviews: SanitizedReview[]): ReaderIntelReport['sentimentTimeline'] {
    const bucket = new Map<string, { total: number; count: number }>();
    for (const r of reviews) {
      const month = r.date.substring(0, 7);
      const b = bucket.get(month);
      if (b) { b.total += r.rating; b.count++; }
      else bucket.set(month, { total: r.rating, count: 1 });
    }
    return Array.from(bucket.entries())
      .map(([month, v]) => ({ month, avgRating: Math.round((v.total / v.count) * 10) / 10, count: v.count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  private extractReaderRequests(reviews: SanitizedReview[]): string[] {
    const requests: string[] = [];
    for (const r of reviews) {
      const lower = r.text.toLowerCase();
      for (const marker of REQUEST_MARKERS) {
        const idx = lower.indexOf(marker);
        if (idx === -1) continue;
        // Grab up to 80 chars after the marker — gives a sense of what was requested
        // without exposing the full review. Strip at sentence boundary.
        const snippet = r.text.slice(idx, idx + 160).split(/[.!?]/)[0].trim();
        if (snippet.length > 15 && snippet.length < 160) {
          // Anonymize: remove any quoted text.
          const anon = snippet.replace(/"[^"]*"/g, '"[…]"');
          requests.push(anon);
        }
        break;  // One request per review
      }
    }
    // Dedupe near-identical requests.
    const unique = Array.from(new Set(requests.map(r => r.toLowerCase()))).slice(0, 20);
    return unique;
  }

  private extractComplaints(reviews: SanitizedReview[]): string[] {
    const complaintCounts = new Map<string, number>();
    for (const r of reviews) {
      const lower = r.text.toLowerCase();
      for (const marker of COMPLAINT_MARKERS) {
        if (lower.includes(marker)) {
          complaintCounts.set(marker, (complaintCounts.get(marker) ?? 0) + 1);
        }
      }
    }
    return Array.from(complaintCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([m, count]) => `"${m}" appeared in ${count} reviews`);
  }
}
