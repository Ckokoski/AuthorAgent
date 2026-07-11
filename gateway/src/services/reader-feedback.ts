/**
 * AuthorAgent Reader-Feedback Moat Service
 *
 * Closes the loop no other author tool closes: it ingests PUBLIC serialization
 * stats + reader comments from where a book is already being read chapter-by-
 * chapter (Royal Road first; Wattpad stubbed), analyzes the reader reaction,
 * and produces a ReaderSignalReport so the NEXT chapter can be written with
 * real reader data instead of guesswork.
 *
 * ── Design constraints (mirrors bestseller-trends.ts + research.ts + sleep-
 *    consolidation.ts patterns already in gateway/src/services) ──
 *   1. GRACEFUL DEGRADATION: ingestion never throws. If a page's structure
 *      doesn't match, we degrade to whatever parsed + push a warning. Callers
 *      always get a typed report, never an exception.
 *   2. POLITENESS (public pages only, no login, no auth-walled scraping):
 *        - Honest User-Agent identifying the bot + a contact URL.
 *        - Hard cap of ~10 HTTP requests per sync.
 *        - ≥2s spacing between requests (injectable sleep/clock so the spacing
 *          logic is unit-testable without real waits).
 *        - Only the first N=5 chapters' comment pages are fetched per sync.
 *   3. COST RULE (mirrors sleep-consolidation): the ONE AI call this service
 *      makes (comment-theme summarization) resolves to a FREE-tier provider
 *      only — task types 'general' | 'marketing' — and FAILS CLOSED (skips the
 *      summary, records a warning) if the router hands back a paid provider.
 *
 * ── FUTURE HOOK (documented, NOT implemented here) ──
 *   The report's `commentThemes` is exactly the kind of durable, per-project
 *   reader signal that belongs in CORE memory's P3 slot (see memory-tier.ts /
 *   sleep-consolidation.ts CoreDigest). A later wave can have the CoreDigest
 *   materialization pass read getReport(projectId).commentThemes and fold the
 *   "what readers are telling you" bullets into the next-chapter drafting
 *   prompt. This wave deliberately stops at ingestion + analysis + API — it
 *   does NOT wire commentThemes into any writing prompt yet.
 */

import { mkdir, writeFile, readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Config + report types
// ═══════════════════════════════════════════════════════════

export type ReaderFeedbackPlatform = 'royalroad' | 'wattpad';

/** Per-project reader-feedback configuration. */
export interface ReaderFeedbackConfig {
  platform: ReaderFeedbackPlatform;
  /** Public fiction URL, e.g. https://www.royalroad.com/fiction/12345/my-story */
  fictionUrl: string;
  /** Kill switch — sync is a no-op when false. */
  enabled: boolean;
}

/** Fiction-level stats scraped from the fiction landing page. All optional —
 *  Royal Road markup shifts, so every field degrades independently. */
export interface FictionStats {
  title?: string;
  followers?: number;
  favorites?: number;
  /** Total ratings count (number of people who rated). */
  ratings?: number;
  /** Overall star score if present (0-5). */
  score?: number;
  /** Total pages reported by the site. */
  pages?: number;
  /** Total views reported by the site. */
  views?: number;
}

/** Per-chapter row. `retentionDropVsPrev` is the chapter-over-chapter view
 *  dropoff proxy (fraction 0-1; positive = fewer views than previous chapter). */
export interface ChapterSignal {
  title: string;
  url?: string;
  /** ISO date or raw date string as published on the site. */
  date?: string;
  views?: number;
  /** Retention proxy: (prevViews - thisViews) / prevViews, when both known. */
  retentionDropVsPrev?: number;
}

/** AI-summarized reader-sentiment themes derived from scraped comments. */
export interface CommentThemes {
  /** Ranked sentiment/topic themes (short phrases). */
  themes: string[];
  /** "What readers are telling you" — actionable bullets for the next chapter. */
  whatReadersAreTellingYou: string[];
  /** How many raw comments fed the summary. */
  commentsAnalyzed: number;
  /** Provider that produced the summary, or 'skipped' when no AI ran. */
  source: 'free-ai' | 'skipped';
}

export interface ReaderSignalReport {
  projectId: string;
  platform: ReaderFeedbackPlatform;
  fictionUrl: string;
  /** 'live' = fetched this run; 'cached' = returned from store; 'unsupported'
   *  = platform (e.g. Wattpad) can't be scraped server-side. */
  source: 'live' | 'cached' | 'unsupported';
  fictionStats: FictionStats;
  chapters: ChapterSignal[];
  commentThemes: CommentThemes;
  /** Non-fatal parse/politeness/cost warnings — always present (may be empty). */
  warnings: string[];
  /** ISO timestamp of when this report was produced. */
  syncedAt: string;
  /** Human-readable note (used for the Wattpad unsupported message, etc.). */
  message?: string;
}

// ═══════════════════════════════════════════════════════════
// Injected ports
// ═══════════════════════════════════════════════════════════

/** Minimal HTTP GET port. Returns the body text + status; NEVER throws
 *  (implementations should catch and return ok:false). Injectable so tests
 *  feed fixture HTML and the prod wiring reuses ResearchGate/global fetch. */
export type ReaderFeedbackHttpGet = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status: number; text: string; error?: string }>;

/** AI completion closure — identical shape to the router's complete(). */
export type ReaderFeedbackAICompleteFn = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

/** Provider selection closure; widened to expose optional `tier` for the
 *  fail-closed cost guard (matches sleep-consolidation.ts). */
export type ReaderFeedbackAISelectProviderFn = (taskType: string) => { id: string; tier?: string };

export interface ReaderFeedbackDeps {
  workspaceDir: string;
  /** HTTP GET. Defaults to a polite global-fetch implementation. */
  httpGet?: ReaderFeedbackHttpGet;
  aiComplete?: ReaderFeedbackAICompleteFn;
  aiSelectProvider?: ReaderFeedbackAISelectProviderFn;
  /** Async delay used for polite request spacing. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock (ms). Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

// ═══════════════════════════════════════════════════════════
// Politeness / cost tuning
// ═══════════════════════════════════════════════════════════

/** Honest, identifying UA — no impersonation of a browser. */
export const READER_FEEDBACK_USER_AGENT =
  'AuthorAgent/1.0 (reader-feedback; +github.com/Ckokoski/authoragent)';
/** Minimum spacing between HTTP requests within a sync. */
export const MIN_REQUEST_SPACING_MS = 2000;
/** Hard ceiling on HTTP requests per sync (fiction page + chapter list + up to
 *  N comment pages, with headroom). */
export const MAX_REQUESTS_PER_SYNC = 10;
/** Max chapters whose comment pages we fetch per sync. */
export const MAX_COMMENT_CHAPTERS = 5;
/** Free-tier task types the ONE AI call is allowed to request. */
const FREE_TASK_TYPES = new Set(['general', 'marketing']);
/** Per-sync HTTP request timeout. */
const REQUEST_TIMEOUT_MS = 15000;

interface StoreShape {
  /** projectId -> { config, lastReport? } */
  [projectId: string]: {
    config: ReaderFeedbackConfig;
    lastReport?: ReaderSignalReport;
  };
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class ReaderFeedbackService {
  private storePath: string;
  private dataDir: string;
  private httpGet: ReaderFeedbackHttpGet;
  private aiComplete?: ReaderFeedbackAICompleteFn;
  private aiSelectProvider?: ReaderFeedbackAISelectProviderFn;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private store: StoreShape = {};

  constructor(deps: ReaderFeedbackDeps) {
    this.dataDir = join(deps.workspaceDir, 'data');
    this.storePath = join(this.dataDir, 'reader-feedback.json');
    this.httpGet = deps.httpGet ?? defaultHttpGet;
    this.aiComplete = deps.aiComplete;
    this.aiSelectProvider = deps.aiSelectProvider;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadStore();
  }

  // ── Persistence (atomic tmp+rename, mirrors image-gen config) ──

  private async loadStore(): Promise<void> {
    try {
      if (!existsSync(this.storePath)) {
        this.store = {};
        return;
      }
      const raw = await readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.store = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Corrupted store — start empty in-memory, don't clobber the file.
      this.store = {};
    }
  }

  private async saveStore(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = this.storePath + '.tmp';
    await writeFile(tmp, JSON.stringify(this.store, null, 2));
    await rename(tmp, this.storePath);
  }

  // ── Config ──

  /** Current config for a project, or null if none set. */
  getConfig(projectId: string): ReaderFeedbackConfig | null {
    return this.store[projectId]?.config ?? null;
  }

  /**
   * Set/merge a project's reader-feedback config. Validates platform +
   * fictionUrl. Returns the resulting config.
   */
  async setConfig(projectId: string, update: Partial<ReaderFeedbackConfig>): Promise<ReaderFeedbackConfig> {
    const prior = this.store[projectId]?.config;
    const platform = (update.platform ?? prior?.platform ?? 'royalroad') as ReaderFeedbackPlatform;
    if (platform !== 'royalroad' && platform !== 'wattpad') {
      throw new Error(`Unsupported platform "${platform}". Use 'royalroad' or 'wattpad'.`);
    }
    const fictionUrl = (update.fictionUrl ?? prior?.fictionUrl ?? '').trim();
    if (!fictionUrl || !/^https?:\/\//i.test(fictionUrl)) {
      throw new Error('fictionUrl (a public http(s) URL) is required.');
    }
    const config: ReaderFeedbackConfig = {
      platform,
      fictionUrl,
      enabled: update.enabled ?? prior?.enabled ?? true,
    };
    this.store[projectId] = { ...(this.store[projectId] ?? {}), config };
    await this.saveStore();
    return config;
  }

  // ── Report accessors ──

  /** Cached last report for a project (no network), or null. */
  getReport(projectId: string): ReaderSignalReport | null {
    return this.store[projectId]?.lastReport ?? null;
  }

  /**
   * Cron-shaped bulk entry point (CronHandler shape). Syncs every enabled,
   * configured project. Never rejects — per-project failures degrade to a
   * warning-bearing report. Suitable for a weekly cron registration.
   */
  async syncAll(): Promise<{ success: boolean; message: string; details?: any }> {
    const ids = Object.keys(this.store).filter(id => this.store[id]?.config?.enabled);
    if (ids.length === 0) {
      return { success: true, message: 'No reader-feedback projects to sync', details: { projects: [] } };
    }
    const results: Array<{ projectId: string; chapters: number; warnings: number }> = [];
    for (const id of ids) {
      const report = await this.sync(id);
      results.push({ projectId: id, chapters: report.chapters.length, warnings: report.warnings.length });
    }
    return {
      success: true,
      message: `Synced ${results.length} reader-feedback project(s)`,
      details: { projects: results },
    };
  }

  /**
   * Live ingestion for one project. Fetches public pages, parses stats +
   * chapters + comments, runs the (free-tier) comment-theme summary, caches
   * the report, and returns it. NEVER throws — all failures become warnings.
   */
  async sync(projectId: string): Promise<ReaderSignalReport> {
    const config = this.getConfig(projectId);
    if (!config) {
      return this.emptyReport(projectId, 'royalroad', '', 'live', ['No reader-feedback config for this project.']);
    }
    if (!config.enabled) {
      return this.emptyReport(projectId, config.platform, config.fictionUrl, 'live', ['Reader feedback is disabled for this project.']);
    }

    let report: ReaderSignalReport;
    if (config.platform === 'wattpad') {
      report = this.wattpadStub(projectId, config);
    } else {
      report = await this.syncRoyalRoad(projectId, config);
    }

    // Cache the report in the same store.
    this.store[projectId] = { ...(this.store[projectId] ?? { config }), config, lastReport: report };
    try {
      await this.saveStore();
    } catch (err: any) {
      report.warnings.push(`Failed to persist report: ${err?.message || String(err)}`);
    }
    return report;
  }

  // ═══════════════════════════════════════════════════════════
  // Royal Road ingestion
  // ═══════════════════════════════════════════════════════════

  private async syncRoyalRoad(projectId: string, config: ReaderFeedbackConfig): Promise<ReaderSignalReport> {
    const warnings: string[] = [];
    // Shared politeness budget threaded through every fetch this sync makes.
    const budget = { requests: 0, lastRequestAt: 0 };

    // 1) Fiction landing page — stats + chapter list live here.
    const fictionHtml = await this.politeGet(config.fictionUrl, budget, warnings);
    let fictionStats: FictionStats = {};
    let chapters: ChapterSignal[] = [];
    if (fictionHtml) {
      fictionStats = this.parseFictionStats(fictionHtml, warnings);
      chapters = this.parseChapterList(fictionHtml, config.fictionUrl, warnings);
    } else {
      warnings.push('Fiction page could not be fetched — no stats or chapters parsed.');
    }

    // 2) Comments: fetch up to MAX_COMMENT_CHAPTERS chapter pages (respecting
    //    the request budget) and harvest comment text.
    const comments: string[] = [];
    const commentTargets = chapters.filter(c => c.url).slice(0, MAX_COMMENT_CHAPTERS);
    for (const ch of commentTargets) {
      if (budget.requests >= MAX_REQUESTS_PER_SYNC) {
        warnings.push(`Request cap (${MAX_REQUESTS_PER_SYNC}) reached — stopped harvesting comments early.`);
        break;
      }
      const chapterHtml = await this.politeGet(ch.url!, budget, warnings);
      if (!chapterHtml) continue;
      const found = this.parseComments(chapterHtml);
      comments.push(...found);
    }

    // 3) Retention proxy: chapter-over-chapter view dropoff.
    chapters = this.computeRetention(chapters);

    // 4) ONE free-tier AI call to summarize comment sentiment (fails closed).
    const commentThemes = await this.summarizeComments(comments, fictionStats.title, warnings);

    return {
      projectId,
      platform: 'royalroad',
      fictionUrl: config.fictionUrl,
      source: 'live',
      fictionStats,
      chapters,
      commentThemes,
      warnings,
      syncedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Polite GET: enforces per-sync request cap + ≥2s spacing (using the
   * injectable clock/sleep). Returns HTML on success, or null (with a warning)
   * on cap/failure. Never throws.
   */
  private async politeGet(
    url: string,
    budget: { requests: number; lastRequestAt: number },
    warnings: string[],
  ): Promise<string | null> {
    if (budget.requests >= MAX_REQUESTS_PER_SYNC) {
      warnings.push(`Request cap (${MAX_REQUESTS_PER_SYNC}) reached — skipped ${url}.`);
      return null;
    }
    // Space requests out politely.
    const wait = this.computeSpacingWait(budget.lastRequestAt);
    if (wait > 0) await this.sleep(wait);

    budget.requests++;
    budget.lastRequestAt = this.now();
    try {
      const res = await this.httpGet(url, { 'User-Agent': READER_FEEDBACK_USER_AGENT });
      if (!res.ok) {
        warnings.push(`Fetch failed (${res.status}) for ${url}${res.error ? `: ${res.error}` : ''}.`);
        return null;
      }
      return res.text;
    } catch (err: any) {
      warnings.push(`Fetch threw for ${url}: ${err?.message || String(err)}.`);
      return null;
    }
  }

  /** Pure spacing calc — how long to wait so requests are ≥MIN_REQUEST_SPACING_MS
   *  apart. Exposed-ish (via computeSpacingWait) so it's unit-testable. */
  computeSpacingWait(lastRequestAt: number): number {
    if (!lastRequestAt) return 0;
    const elapsed = this.now() - lastRequestAt;
    return elapsed >= MIN_REQUEST_SPACING_MS ? 0 : MIN_REQUEST_SPACING_MS - elapsed;
  }

  // ── Parsers (regex/string-based, no cheerio, degrade gracefully) ──

  /**
   * Parse fiction-level stats from the Royal Road fiction page. Royal Road
   * renders stats as labelled list items ("Followers", "Favorites", "Ratings",
   * "Pages", "Total Views") plus an overall score. We scan for a label and grab
   * the nearest number. Any field that doesn't match is simply left undefined.
   */
  parseFictionStats(html: string, warnings: string[]): FictionStats {
    const stats: FictionStats = {};
    try {
      // Title: <h1 ...>Title</h1> or og:title meta.
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1) {
        const t = stripTags(h1[1]).trim();
        if (t) stats.title = t;
      }
      if (!stats.title) {
        const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
        if (og) stats.title = decodeEntities(og[1]).trim();
      }

      stats.followers = findLabeledNumber(html, 'Followers');
      stats.favorites = findLabeledNumber(html, 'Favorites');
      stats.ratings = findLabeledNumber(html, 'Ratings');
      stats.pages = findLabeledNumber(html, 'Pages');
      stats.views = findLabeledNumber(html, 'Total Views') ?? findLabeledNumber(html, 'Views');

      // Overall score: Royal Road exposes an aria-label like "5 stars" or a
      // data-content attribute with the numeric score.
      const scoreAttr = html.match(/data-content=["']([0-9](?:\.[0-9]+)?)["'][^>]*>\s*<[^>]*star/i)
        || html.match(/aria-label=["']([0-9](?:\.[0-9]+)?)\s*stars?["']/i);
      if (scoreAttr) {
        const v = parseFloat(scoreAttr[1]);
        if (!Number.isNaN(v)) stats.score = v;
      }

      // Prune undefined keys so the report is clean.
      for (const k of Object.keys(stats) as (keyof FictionStats)[]) {
        if (stats[k] === undefined) delete stats[k];
      }
      if (Object.keys(stats).length === 0) {
        warnings.push('Fiction stats block did not match expected structure — no stats parsed.');
      }
    } catch (err: any) {
      warnings.push(`Fiction-stats parse error: ${err?.message || String(err)}.`);
    }
    return stats;
  }

  /**
   * Parse the chapter list. Royal Road renders a chapter table where each row
   * links to /fiction/<id>/<slug>/chapter/<cid>/<cslug> and carries the chapter
   * title + a <time> element (datetime attr). Views per-chapter aren't reliably
   * on the fiction page, so `views` is best-effort (usually undefined here).
   */
  parseChapterList(html: string, fictionUrl: string, warnings: string[]): ChapterSignal[] {
    const chapters: ChapterSignal[] = [];
    try {
      const base = originOf(fictionUrl);
      // Match anchors that point at a chapter URL. Capture href + inner text.
      const anchorRe = /<a[^>]+href=["']([^"']*\/chapter\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((m = anchorRe.exec(html)) !== null) {
        const href = m[1];
        const title = stripTags(m[2]).replace(/\s+/g, ' ').trim();
        if (!title) continue;
        // Skip the "Start Reading" CTA button, which also links to a chapter.
        if (/^start reading$/i.test(title)) continue;
        const url = href.startsWith('http') ? href : base + (href.startsWith('/') ? href : '/' + href);
        if (seen.has(url)) continue; // rows sometimes duplicate the link
        seen.add(url);
        chapters.push({ title, url });
      }

      // Attach dates from <time datetime="..."> occurrences in row order, if
      // the count lines up. Best-effort only.
      const times = [...html.matchAll(/<time[^>]+(?:datetime|unixtime)=["']([^"']+)["']/gi)].map(t => t[1]);
      if (times.length >= chapters.length && chapters.length > 0) {
        for (let i = 0; i < chapters.length; i++) {
          const raw = times[i];
          chapters[i].date = /^\d{9,}$/.test(raw)
            ? new Date(parseInt(raw, 10) * 1000).toISOString()
            : raw;
        }
      }

      if (chapters.length === 0) {
        warnings.push('No chapter links matched — chapter list structure may have changed.');
      }
    } catch (err: any) {
      warnings.push(`Chapter-list parse error: ${err?.message || String(err)}.`);
    }
    return chapters;
  }

  /**
   * Harvest comment text from a chapter page. Royal Road renders comments in
   * containers with class "comment" holding a body element (class contains
   * "comment" + "content"/"body"/"text"). We extract visible text from those
   * blocks. Returns [] if nothing matched (no throw).
   */
  parseComments(html: string): string[] {
    const out: string[] = [];
    try {
      // Grab blocks whose class mentions a comment body/content/text.
      const blockRe = /<div[^>]+class=["'][^"']*comment[^"']*(?:content|body|text)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(html)) !== null) {
        const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();
        if (text && text.length > 1) out.push(text.slice(0, 500));
      }
    } catch {
      /* degrade to whatever we collected */
    }
    return out;
  }

  /** Chapter-over-chapter view dropoff retention proxy. */
  computeRetention(chapters: ChapterSignal[]): ChapterSignal[] {
    for (let i = 1; i < chapters.length; i++) {
      const prev = chapters[i - 1].views;
      const cur = chapters[i].views;
      if (typeof prev === 'number' && prev > 0 && typeof cur === 'number') {
        chapters[i].retentionDropVsPrev = Math.round(((prev - cur) / prev) * 1000) / 1000;
      }
    }
    return chapters;
  }

  // ── Comment-theme summary (ONE free-tier AI call, fails closed) ──

  private async summarizeComments(
    comments: string[],
    fictionTitle: string | undefined,
    warnings: string[],
  ): Promise<CommentThemes> {
    const skipped = (why: string): CommentThemes => {
      if (why) warnings.push(why);
      return { themes: [], whatReadersAreTellingYou: [], commentsAnalyzed: comments.length, source: 'skipped' };
    };

    if (comments.length === 0) return skipped('');
    if (!this.aiComplete || !this.aiSelectProvider) {
      return skipped('No AI router wired — comment-theme summary skipped.');
    }

    // Cost rule: resolve a free-tier provider or fail closed.
    let provider: { id: string; tier?: string };
    try {
      provider = this.resolveFreeProvider('general');
    } catch (err: any) {
      return skipped(`Comment summary skipped (cost rule): ${err?.message || String(err)}`);
    }

    const sample = comments.slice(0, 60).map(c => `- ${c}`).join('\n').slice(0, 6000);
    const system =
      'You are a reader-feedback analyst for a serialized web novel. Given raw ' +
      'reader comments, identify the dominant sentiment/topic THEMES and turn ' +
      'them into concrete guidance for the author\'s NEXT chapter. Return ONLY ' +
      'valid JSON: {"themes":["..."],"whatReadersAreTellingYou":["..."]}. ' +
      'No markdown, no preamble. Keep each item a short phrase.';
    const user =
      (fictionTitle ? `Fiction: ${fictionTitle}\n\n` : '') +
      `Reader comments (${comments.length} total, sample below):\n${sample}`;

    try {
      const res = await this.aiComplete({
        provider: provider.id,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 500,
        temperature: 0.2,
      });
      const parsed = safeJson(res.text || '');
      const themes = Array.isArray(parsed?.themes) ? parsed.themes.map((s: any) => String(s)).filter(Boolean) : [];
      const guidance = Array.isArray(parsed?.whatReadersAreTellingYou)
        ? parsed.whatReadersAreTellingYou.map((s: any) => String(s)).filter(Boolean)
        : [];
      if (themes.length === 0 && guidance.length === 0) {
        return skipped('Comment summary returned no parseable themes.');
      }
      return {
        themes,
        whatReadersAreTellingYou: guidance,
        commentsAnalyzed: comments.length,
        source: 'free-ai',
      };
    } catch (err: any) {
      return skipped(`Comment summary AI call failed: ${err?.message || String(err)}`);
    }
  }

  /**
   * Resolve a provider for a free-tier task type, THROWING if the router hands
   * back a non-free provider (fail closed) — mirrors sleep-consolidation.ts.
   */
  private resolveFreeProvider(taskType: 'general' | 'marketing'): { id: string; tier?: string } {
    if (!FREE_TASK_TYPES.has(taskType)) {
      throw new Error(`task type "${taskType}" is not free-tier`);
    }
    const provider = this.aiSelectProvider!(taskType);
    if (provider.tier && provider.tier !== 'free') {
      throw new Error(`provider "${provider.id}" resolved to non-free tier "${provider.tier}"`);
    }
    return provider;
  }

  // ── Wattpad stub ──

  /**
   * Wattpad's story + chapter pages are heavily JS-rendered (content loads
   * client-side), so server-side HTML scraping yields no usable stats/comments
   * without a headless browser — out of scope + against their ToS for this
   * wave. We return the SAME report shape, honestly marked unsupported.
   */
  private wattpadStub(projectId: string, config: ReaderFeedbackConfig): ReaderSignalReport {
    return {
      projectId,
      platform: 'wattpad',
      fictionUrl: config.fictionUrl,
      source: 'unsupported',
      fictionStats: {},
      chapters: [],
      commentThemes: { themes: [], whatReadersAreTellingYou: [], commentsAnalyzed: 0, source: 'skipped' },
      warnings: [],
      syncedAt: new Date(this.now()).toISOString(),
      message:
        'Wattpad ingestion is not supported: their story/chapter pages render ' +
        'content client-side (JS), so public server-side scraping returns no ' +
        'usable stats or comments. Use Royal Road for live reader-feedback, or ' +
        'export/paste Wattpad comments manually for analysis.',
    };
  }

  private emptyReport(
    projectId: string,
    platform: ReaderFeedbackPlatform,
    fictionUrl: string,
    source: ReaderSignalReport['source'],
    warnings: string[],
  ): ReaderSignalReport {
    return {
      projectId,
      platform,
      fictionUrl,
      source,
      fictionStats: {},
      chapters: [],
      commentThemes: { themes: [], whatReadersAreTellingYou: [], commentsAnalyzed: 0, source: 'skipped' },
      warnings,
      syncedAt: new Date(this.now()).toISOString(),
    };
  }
}

// ═══════════════════════════════════════════════════════════
// Standalone helpers (pure, testable)
// ═══════════════════════════════════════════════════════════

/** Default polite HTTP GET over global fetch — never throws. */
const defaultHttpGet: ReaderFeedbackHttpGet = async (url, headers) => {
  try {
    const res = await globalThis.fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 200000) };
  } catch (err: any) {
    return { ok: false, status: 0, text: '', error: err?.message || String(err) };
  }
};

/** Strip HTML tags and decode common entities to plain text. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '));
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    // Numeric entities (decimal + hex) — covers &#x2019; (’), &#8217;, etc.
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; last so we don't double-decode entities that contained an ampersand.
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp: number): string {
  try {
    return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : '';
  } catch {
    return '';
  }
}

/** Origin (scheme://host) of a URL, or '' if unparseable. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * Find a number associated with a label in the HTML. Royal Road pairs a label
 * ("Followers") with a sibling value; we look for the label then grab the first
 * number-looking token that follows within a short window. Commas stripped.
 * Returns undefined if not found.
 */
export function findLabeledNumber(html: string, label: string): number | undefined {
  const idx = html.search(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  if (idx < 0) return undefined;
  // Look at the ~200 chars around the label for the nearest number.
  const window = html.slice(idx, idx + 200);
  // Skip the label text itself, then find first number with optional commas/decimals.
  const after = window.replace(new RegExp('^[\\s\\S]*?' + label, 'i'), '');
  const num = after.match(/([\d][\d,]*(?:\.\d+)?)/);
  if (!num) return undefined;
  const v = parseFloat(num[1].replace(/,/g, ''));
  return Number.isNaN(v) ? undefined : v;
}

/** Best-effort JSON parse (strips code fences); returns null on failure. */
export function safeJson(text: string): any {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
