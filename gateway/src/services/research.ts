/**
 * AuthorAgent Research Gate
 * Constrained internet access for research only
 * Domain allowlist prevents access to banking, social login, admin panels
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { AuditLog } from '../security/audit.js';

export class ResearchGate {
  private allowlistPath: string;
  private audit: AuditLog;
  private allowedDomains: Set<string> = new Set();
  private requestCount = 0;
  private maxRequestsPerHour = 60;
  private requestTimestamps: number[] = [];

  constructor(allowlistPath: string, audit: AuditLog) {
    this.allowlistPath = allowlistPath;
    this.audit = audit;
  }

  async initialize(): Promise<void> {
    if (existsSync(this.allowlistPath)) {
      const raw = await readFile(this.allowlistPath, 'utf-8');
      const data = JSON.parse(raw);
      // Normalize on load — same as setDomains() to prevent case/www mismatches
      this.allowedDomains = new Set(
        (data.domains || []).map((d: string) => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean)
      );
    }
  }

  getAllowedDomainCount(): number {
    return this.allowedDomains.size;
  }

  getAllowedDomains(): string[] {
    return Array.from(this.allowedDomains).sort();
  }

  /**
   * Replace the domain allowlist and persist to disk.
   */
  async setDomains(domains: string[]): Promise<void> {
    // Normalize: lowercase, strip www prefix, deduplicate, sort for consistent display
    const normalized = domains
      .map(d => d.trim().toLowerCase().replace(/^www\./, ''))
      .filter(Boolean);
    this.allowedDomains = new Set(normalized);
    const sorted = Array.from(this.allowedDomains).sort();
    const data = {
      description: 'Approved domains for AuthorAgent research. Add domains as needed for your writing projects.',
      domains: sorted,
    };
    await writeFile(this.allowlistPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  isAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, '');

      // Check exact match and wildcard
      if (this.allowedDomains.has(domain)) return true;

      // Check parent domain (e.g., *.google.com)
      const parts = domain.split('.');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(i).join('.');
        if (this.allowedDomains.has('*.' + parent)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  checkRateLimit(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 3600000);
    if (this.requestTimestamps.length >= this.maxRequestsPerHour) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  async fetch(url: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    if (!this.isAllowed(url)) {
      await this.audit.log('research', 'blocked_domain', { url });
      return { ok: false, error: `Domain not on research allowlist: ${url}` };
    }

    if (!this.checkRateLimit()) {
      return { ok: false, error: 'Research rate limit exceeded. Try again later.' };
    }

    try {
      const response = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'AuthorAgent-Research/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      await this.audit.log('research', 'fetch_success', { url, status: response.status });
      return { ok: true, text: text.substring(0, 50000) }; // Cap response size
    } catch (error) {
      await this.audit.log('research', 'fetch_error', { url, error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Fetch a URL and extract clean text content from the HTML.
   * Strips scripts, styles, nav, headers, footers, then HTML tags.
   */
  async fetchAndExtract(url: string): Promise<{ ok: boolean; text?: string; title?: string; error?: string }> {
    const result = await this.fetch(url);
    if (!result.ok || !result.text) return result;

    const extracted = this.extractText(result.text);
    return { ok: true, text: extracted.text.substring(0, 30000), title: extracted.title };
  }

  /**
   * Search for research content using multiple free APIs.
   * Primary: Wikipedia API (always works, no CAPTCHA, great for author research).
   * Also searches Google Books for book-related queries.
   * Results are filtered through the domain allowlist.
   */
  async search(query: string, maxResults: number = 5): Promise<{
    results: Array<{ title: string; url: string; snippet: string; source?: string }>;
    blocked: Array<{ url: string; reason: string }>;
    error?: string;
  }> {
    if (!this.checkRateLimit()) {
      return { results: [], blocked: [], error: 'Rate limit exceeded (60/hour). Try again later.' };
    }

    await this.audit.log('research', 'search', { query, maxResults });

    const allResults: Array<{ title: string; url: string; snippet: string; source?: string }> = [];
    const blocked: Array<{ url: string; reason: string }> = [];
    const errors: string[] = [];

    // Search Wikipedia (primary — always works, most useful for author research)
    try {
      const wikiResults = await this.searchWikipedia(query, maxResults);
      for (const r of wikiResults) {
        if (this.isAllowed(r.url)) {
          allResults.push(r);
        } else {
          blocked.push({ url: r.url, reason: 'Domain not on allowlist' });
        }
      }
    } catch (error) {
      errors.push('Wikipedia: ' + String(error));
    }

    // Search Google Books if we need more results and it's on the allowlist
    if (allResults.length < maxResults) {
      try {
        const bookResults = await this.searchGoogleBooks(query, maxResults - allResults.length);
        for (const r of bookResults) {
          if (this.isAllowed(r.url)) {
            allResults.push(r);
          } else {
            blocked.push({ url: r.url, reason: 'Domain not on allowlist' });
          }
        }
      } catch (error) {
        errors.push('Google Books: ' + String(error));
      }
    }

    await this.audit.log('research', 'search_complete', {
      query,
      found: allResults.length + blocked.length,
      allowed: allResults.length,
      blocked: blocked.length,
      sources: ['wikipedia', 'google-books'],
    });

    return {
      results: allResults.slice(0, maxResults),
      blocked,
      error: allResults.length === 0 && errors.length > 0
        ? 'Search errors: ' + errors.join('; ')
        : undefined,
    };
  }

  /**
   * Search Wikipedia using the MediaWiki API.
   * Free, no API key, no CAPTCHA, returns titles + snippets.
   */
  private async searchWikipedia(query: string, limit: number): Promise<
    Array<{ title: string; url: string; snippet: string; source: string }>
  > {
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      srlimit: String(Math.min(limit, 10)),
      srprop: 'snippet|titlesnippet',
      origin: '*',
    });

    const response = await globalThis.fetch(
      `https://en.wikipedia.org/w/api.php?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await response.json() as any;

    if (!data.query?.search) return [];

    return data.query.search.map((item: any) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: (item.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      source: 'Wikipedia',
    }));
  }

  /**
   * Search Google Books API (free, no key required for basic search).
   * Returns books related to the query.
   */
  private async searchGoogleBooks(query: string, limit: number): Promise<
    Array<{ title: string; url: string; snippet: string; source: string }>
  > {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(limit, 5)),
      printType: 'books',
      orderBy: 'relevance',
    });

    const response = await globalThis.fetch(
      `https://www.googleapis.com/books/v1/volumes?${params}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await response.json() as any;

    if (!data.items) return [];

    return data.items.map((item: any) => {
      const info = item.volumeInfo || {};
      const authors = info.authors ? info.authors.join(', ') : 'Unknown';
      return {
        title: `${info.title || 'Untitled'} — by ${authors}`,
        url: info.infoLink || `https://books.google.com/books?id=${item.id}`,
        snippet: (info.description || '').substring(0, 300),
        source: 'Google Books',
      };
    });
  }

  /**
   * Extract readable text content from HTML.
   * Lightweight — no external dependencies.
   */
  private extractText(html: string): { text: string; title: string } {
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    let text = html;

    // Remove unwanted sections entirely
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Convert block elements to newlines
    text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, '\n');

    // Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#039;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');

    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.trim();

    return { text, title };
  }
}
