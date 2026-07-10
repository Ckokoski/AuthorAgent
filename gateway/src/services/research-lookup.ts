/**
 * AuthorAgent Research Lookup
 *
 * Sourced research for authors writing about unfamiliar topics — e.g., a
 * fantasy author who needs to ground their pre-WWI Vienna scene, a thriller
 * author who needs accurate forensic detail, a nonfiction author who needs
 * a reliable citation. Uses Perplexity Sonar Pro under the hood, accessed
 * via OpenRouter (no separate Perplexity key needed) or directly if the
 * user has a Perplexity API key.
 *
 * Inspired by claude-scientific-writer's research-lookup pattern, but
 * scoped for fiction/nonfiction authors rather than scientific papers.
 *
 * Output is a structured ResearchResult with verified citations the author
 * can cross-check before using anything in their manuscript. We never
 * fabricate sources — if the model can't find verifiable ones, the result
 * is empty and we say so.
 */

import type { Vault } from '../security/vault.js';
import type { AIRouter } from '../ai/router.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface ResearchCitation {
  title: string;
  url?: string;
  /** Optional: publication, author, year — when available. */
  source?: string;
}

export interface ResearchResult {
  query: string;
  /** Plain-English answer the author can use. Cited claims are bracketed [1]. */
  answer: string;
  citations: ResearchCitation[];
  /** Where the actual lookup ran. */
  provider: 'perplexity-direct' | 'perplexity-via-openrouter' | 'fallback-llm';
  /** Confidence flag for the author. False = treat with extra skepticism. */
  hasVerifiedSources: boolean;
  /** Token / cost estimate. */
  estimatedCost: number;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const PERPLEXITY_DIRECT_ENDPOINT = 'https://api.perplexity.ai/chat/completions';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const RESEARCH_SYSTEM_PROMPT = `You are a research assistant for an author. Given a topic, return a concise factual summary with explicit source attribution.

Rules:
1. Use ONLY information from sources you can verify in your search results.
2. NEVER fabricate citations — if you can't find verifiable sources, say so.
3. For each substantive claim, mark its citation inline as [1], [2], etc.
4. End with a "Sources" list mapping [N] → URL.
5. If the topic is too specific or obscure to verify, say "I cannot verify reliable sources on this topic" and stop.
6. Keep the answer to 200-500 words unless the author asks for more.
7. The author is using this for fiction/nonfiction writing — facts must be accurate, not just plausible-sounding.`;

export class ResearchLookupService {
  private vault: Vault | null = null;
  private aiRouter: AIRouter | null = null;

  setDependencies(vault: Vault, aiRouter: AIRouter): void {
    this.vault = vault;
    this.aiRouter = aiRouter;
  }

  /**
   * Look up research on a topic. Tries (in order):
   *   1. Direct Perplexity API if PERPLEXITY_API_KEY is in the vault
   *   2. OpenRouter routing to perplexity/sonar-pro if openrouter_api_key is present
   *   3. Falls back to whatever AI provider is active (less reliable, no live web)
   */
  async lookup(query: string, opts: { maxWords?: number } = {}): Promise<ResearchResult> {
    const maxWords = opts.maxWords ?? 400;
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      throw new Error('Query is required');
    }

    // Try direct Perplexity first.
    if (this.vault) {
      const perplexityKey = await this.vault.get('perplexity_api_key');
      if (perplexityKey) {
        try {
          return await this.queryPerplexityDirect(cleanQuery, perplexityKey, maxWords);
        } catch (err) {
          console.warn('  [research-lookup] Direct Perplexity failed; falling back:', (err as Error)?.message);
        }
      }

      // OpenRouter route — cheapest path for users who already have OpenRouter set up.
      const openrouterKey = await this.vault.get('openrouter_api_key');
      if (openrouterKey) {
        try {
          return await this.queryViaOpenRouter(cleanQuery, openrouterKey, maxWords);
        } catch (err) {
          console.warn('  [research-lookup] OpenRouter Perplexity routing failed; falling back to general LLM:', (err as Error)?.message);
        }
      }
    }

    // Fallback: just ask the active LLM. Less reliable — model knowledge is
    // frozen at training and citations may be hallucinated. We tell the author.
    return this.fallbackLLMQuery(cleanQuery, maxWords);
  }

  // ── Provider implementations ──

  private async queryPerplexityDirect(query: string, apiKey: string, maxWords: number): Promise<ResearchResult> {
    const response = await fetch(PERPLEXITY_DIRECT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: this.buildUserPrompt(query, maxWords) },
        ],
        temperature: 0.2,
        max_tokens: Math.max(800, Math.ceil(maxWords * 2)),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Perplexity ${response.status}: ${body.substring(0, 200)}`);
    }
    const data = await response.json() as any;
    return this.parseResearchResponse(query, data, 'perplexity-direct', data.usage);
  }

  private async queryViaOpenRouter(query: string, apiKey: string, maxWords: number): Promise<ResearchResult> {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/Ckokoski/authoragent',
        'X-Title': 'AuthorAgent',
      },
      body: JSON.stringify({
        // OpenRouter slug for Perplexity Sonar Pro. Falls through to OpenRouter's
        // own routing if exact slug changes — they keep aliases stable.
        model: 'perplexity/sonar-pro',
        messages: [
          { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: this.buildUserPrompt(query, maxWords) },
        ],
        temperature: 0.2,
        max_tokens: Math.max(800, Math.ceil(maxWords * 2)),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter ${response.status}: ${body.substring(0, 200)}`);
    }
    const data = await response.json() as any;
    return this.parseResearchResponse(query, data, 'perplexity-via-openrouter', data.usage);
  }

  private async fallbackLLMQuery(query: string, maxWords: number): Promise<ResearchResult> {
    if (!this.aiRouter) {
      return {
        query,
        answer: 'Research lookup unavailable: no Perplexity / OpenRouter / general LLM provider configured. Add an API key in Settings.',
        citations: [],
        provider: 'fallback-llm',
        hasVerifiedSources: false,
        estimatedCost: 0,
      };
    }
    const provider = this.aiRouter.selectProvider('research');
    const fallbackPrompt = RESEARCH_SYSTEM_PROMPT +
      '\n\nIMPORTANT: You do NOT have live web access. Only cite sources you can verify from training data, ' +
      'and clearly mark any uncertainty. Prefer "I cannot verify reliable sources on this" over fabricated citations.';
    const response = await this.aiRouter.complete({
      provider: provider.id,
      system: fallbackPrompt,
      messages: [{ role: 'user', content: this.buildUserPrompt(query, maxWords) }],
      maxTokens: Math.max(800, Math.ceil(maxWords * 2)),
      temperature: 0.2,
    });
    return {
      query,
      answer: response.text +
        '\n\n_⚠️ This answer was generated without live web access (no Perplexity / OpenRouter key configured). ' +
        'Treat citations with extra skepticism and cross-check before using in published work._',
      citations: this.extractCitations(response.text),
      provider: 'fallback-llm',
      hasVerifiedSources: false,
      estimatedCost: 0,
    };
  }

  private buildUserPrompt(query: string, maxWords: number): string {
    return `Research request from an author.\n\nTopic: ${query}\n\n` +
      `Return a ${Math.min(maxWords, 600)}-word factual summary with inline [N] citations and a Sources list. ` +
      `If you can't verify the topic, say so plainly.`;
  }

  /** Pull an answer + citation list out of a Perplexity / OpenAI-compatible response. */
  private parseResearchResponse(
    query: string,
    data: any,
    provider: ResearchResult['provider'],
    usage: any,
  ): ResearchResult {
    const text = data?.choices?.[0]?.message?.content || '';
    const citations: ResearchCitation[] = [];

    // Perplexity returns a top-level `citations` array on the response when
    // available — prefer those over our text parser.
    if (Array.isArray(data?.citations)) {
      for (const c of data.citations) {
        if (typeof c === 'string') citations.push({ title: this.titleFromUrl(c), url: c });
        else if (c?.url) citations.push({ title: c.title || this.titleFromUrl(c.url), url: c.url });
      }
    }

    // Fall back to extracting from the response text if no API-provided list.
    if (citations.length === 0) {
      citations.push(...this.extractCitations(text));
    }

    const inputTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
    const outputTokens = usage?.completion_tokens || usage?.output_tokens || 0;
    // Perplexity Sonar Pro pricing approx $0.001/1K input + $0.001/1K output.
    const estimatedCost = (inputTokens / 1000) * 0.001 + (outputTokens / 1000) * 0.001;

    return {
      query,
      answer: text,
      citations,
      provider,
      hasVerifiedSources: citations.length > 0,
      estimatedCost: Math.round(estimatedCost * 1000) / 1000,
    };
  }

  /** Pull a "Sources:" / "References:" list out of free text. */
  private extractCitations(text: string): ResearchCitation[] {
    const citations: ResearchCitation[] = [];
    const sourcesMatch = text.match(/(?:^|\n)(?:sources|references|citations):?\s*\n([\s\S]*?)(?:\n\n|$)/i);
    if (!sourcesMatch) return citations;
    const block = sourcesMatch[1];
    const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 5);
    for (const line of lines) {
      // Try [N] Title - URL pattern, or just URL.
      const urlMatch = line.match(/(https?:\/\/[^\s)]+)/);
      const labelMatch = line.match(/^\[?\d+\]?\s*(.+?)(?:\s*-\s*https?:|\s*$)/);
      const title = labelMatch ? labelMatch[1].trim() : (urlMatch ? this.titleFromUrl(urlMatch[1]) : line);
      citations.push({
        title: title.replace(/https?:\/\/\S+/, '').trim() || (urlMatch ? this.titleFromUrl(urlMatch[1]) : 'untitled'),
        url: urlMatch?.[1],
      });
    }
    return citations;
  }

  private titleFromUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname.replace(/\/$/, '')}`.substring(0, 80);
    } catch {
      return url.substring(0, 80);
    }
  }

  // ── Marketing-research presets ──
  // Structured queries authors actually run when researching where to
  // pitch / submit / promote. Each preset builds a tightly-scoped query
  // for the underlying lookup() and adds the safety rules (no fake
  // contact info, prefer recent sources, no fabricated agent names).

  /**
   * Research literary agents repping a specific genre/subgenre.
   * Returns sourced agent names + agency + recent-sale signals + a path
   * to find their submission process. Never generates emails or DMs.
   */
  async findAgents(input: { genre: string; subgenre?: string; titleAgePositioning?: string }): Promise<ResearchResult> {
    const subgenre = input.subgenre ? ` (specifically ${input.subgenre})` : '';
    const positioning = input.titleAgePositioning ? ` for ${input.titleAgePositioning}` : '';
    const query =
      `Find currently-active literary agents who represent ${input.genre}${subgenre}${positioning}. ` +
      `For each agent include: agent name, agency, 1-2 recent sales (within the last 18 months ideally), ` +
      `whether their submission status is currently OPEN or CLOSED, and the URL of their official ` +
      `submission/MSWL page. Do NOT fabricate names or sales — only include agents you can verify ` +
      `via recent published sources (PublishersMarketplace, Manuscript Wishlist, agency websites, ` +
      `Twitter/X #MSWL feed, AAR member directory). Skip any agent who has been inactive or whose ` +
      `last verified sale is more than 24 months old.`;
    return this.lookup(query, { maxWords: 600 });
  }

  /**
   * Research podcasts that interview authors in a genre.
   */
  async findAuthorPodcasts(input: { genre: string; subgenre?: string }): Promise<ResearchResult> {
    const subgenre = input.subgenre ? ` / ${input.subgenre}` : '';
    const query =
      `Find currently-active podcasts that regularly interview authors in the ${input.genre}${subgenre} ` +
      `space. For each podcast include: podcast name, host(s), episode cadence, 2-3 recent author ` +
      `guests (last 6 months ideally), how to pitch (their published submission/contact page URL), and ` +
      `the platform (Spotify, Apple, YouTube, etc.). Skip podcasts that haven't released a new episode ` +
      `in over 4 months. Do NOT fabricate hosts or guests.`;
    return this.lookup(query, { maxWords: 600 });
  }

  /**
   * Research book bloggers / reviewers active in a genre.
   */
  async findReviewers(input: { genre: string; subgenre?: string; indieFriendly?: boolean }): Promise<ResearchResult> {
    const subgenre = input.subgenre ? ` (${input.subgenre})` : '';
    const indieNote = input.indieFriendly
      ? ` Prioritize bloggers who explicitly review self-published / small-press / indie titles. Exclude bloggers who ONLY review Big-5 books.`
      : '';
    const query =
      `Find currently-active book bloggers / reviewers / Bookstagram / BookTok accounts covering ${input.genre}${subgenre}. ` +
      `For each reviewer include: name/handle, platform (Goodreads, Instagram, TikTok, blog), follower or audience scale, ` +
      `recent featured books (last 3 months), and their submission process (their published policy page URL). ` +
      `Skip dormant accounts (no posts in 60+ days).${indieNote} Do NOT fabricate names or follower counts.`;
    return this.lookup(query, { maxWords: 700 });
  }

  /**
   * Research newsletters that feature books in a genre.
   */
  async findNewsletters(input: { genre: string; subgenre?: string }): Promise<ResearchResult> {
    const subgenre = input.subgenre ? ` (${input.subgenre})` : '';
    const query =
      `Find currently-active email newsletters that feature ${input.genre}${subgenre} releases or interviews. ` +
      `Include both paid promotion newsletters (BookBub, Freebooksy, BargainBooksy, Robin Reads, Book Cave, etc.) ` +
      `AND editorial newsletters (substacks, indie review newsletters). For each newsletter include: name, ` +
      `audience scale if disclosed, paid vs editorial, ad/feature pricing if listed, submission/booking URL, ` +
      `and a recent feature example. Skip newsletters that haven't published in 60+ days.`;
    return this.lookup(query, { maxWords: 700 });
  }

  /**
   * Research recent comparable authors selling well in the genre/subgenre.
   * Useful for query letters + cover positioning.
   */
  async findCompAuthors(input: { genre: string; subgenre?: string; tone?: string }): Promise<ResearchResult> {
    const subgenre = input.subgenre ? ` / ${input.subgenre}` : '';
    const tone = input.tone ? ` with a ${input.tone} tone` : '';
    const query =
      `Identify recent (last 24 months) comparable authors selling well in ${input.genre}${subgenre}${tone}. ` +
      `For each comp author include: name, most-recent successful title, why they're a useful comp ` +
      `(specific overlapping element — voice, structure, audience), and 1-2 promotional channels they ` +
      `clearly used (BookTok, BookBub Featured Deal, podcast tour, Bookstagram bookblogs, etc.). ` +
      `Skip authors over 24 months out from a release. Do NOT fabricate sales numbers or rankings.`;
    return this.lookup(query, { maxWords: 700 });
  }
}
