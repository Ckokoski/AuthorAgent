/**
 * AuthorAgent Plot Promises
 *
 * Sanderson's "promises and payoffs" framework, made concrete:
 *
 * Chapter 1 (and the opening few chapters) implicitly PROMISE certain
 * things to the reader — a mystery to solve, a romance to root for, a
 * confrontation to anticipate, a magic system with rules, a transformation
 * to track. Every promise needs a PAYOFF or the book feels unfinished.
 *
 * What this service does:
 *   1. After the first 1-3 chapters complete, extracts implicit promises
 *      via an AI call. Author confirms / edits / removes any.
 *   2. As subsequent chapters complete, attempts to detect partial or full
 *      payoffs and updates promise state.
 *   3. At configurable threshold (default 80% of project), flags any
 *      unpaid promises so the author can address them in the climax /
 *      resolution rather than leaving readers feeling cheated.
 *
 * What this service does NOT do:
 *   - Auto-rewrite to force a payoff
 *   - Demand every promise be paid (some "promises" are deliberate red
 *     herrings; author marks those as `intentionallyUnpaid`)
 *   - Block project completion
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type PromiseCategory =
  | 'mystery'              // Something will be revealed
  | 'romance'              // Two characters will (or won't) get together
  | 'confrontation'        // Two forces will collide
  | 'transformation'       // A character will change
  | 'world_revelation'     // A truth about the world will emerge
  | 'consequence'          // An action will have a clear cost
  | 'reunion'              // Separated characters / things rejoin
  | 'magic_rule'           // A rule of the magic / tech system will be tested
  | 'red_herring'          // Deliberate misdirection (special category)
  | 'other';

export type PromiseStatus = 'open' | 'partial_payoff' | 'paid_off' | 'intentionally_unpaid' | 'dropped';

export interface PlotPromise {
  id: string;
  /** Short title — "Will Sarah find her sister?" */
  title: string;
  /** Longer description of what was promised. */
  description: string;
  category: PromiseCategory;
  /** Chapter number where the promise was first made. */
  introducedAtChapter: number;
  /** Confidence the AI extracted this correctly (0-1) — author can adjust. */
  confidence: number;
  status: PromiseStatus;
  /** Notes the author has added. */
  authorNotes: string;
  /** Chapters where this promise has been touched (built, complicated, paid). */
  touchedAtChapters: number[];
  /** When the promise was paid off (or marked intentionally unpaid). */
  closedAtChapter?: number;
  closedAtTimestamp?: string;
  /** Author confirmation flag — false until the author has reviewed. */
  authorConfirmed: boolean;
}

export interface ProjectPromises {
  projectId: string;
  promises: PlotPromise[];
  /** When the initial extraction ran. Re-runnable. */
  extractedAt: string | null;
  /** Last time we recomputed payoff status. */
  lastEvaluatedAt: string | null;
}

export interface PromiseAuditReport {
  projectId: string;
  totalPromises: number;
  paidOff: number;
  partialPayoff: number;
  open: number;
  intentionallyUnpaid: number;
  dropped: number;
  /** % of promises closed (paid OR intentionally unpaid). */
  closureRate: number;
  /** Promises that should worry the author given current project progress. */
  atRiskPromises: PlotPromise[];
  summary: string;
}

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

// ═══════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════

const EXTRACT_PROMPT = `You are analyzing the opening chapters of a novel to identify implicit PROMISES the author is making to the reader.

A "promise" is something the opening sets up that the reader is now anticipating: a mystery, a romance, a confrontation, a character transformation, a revelation about the world, a consequence to pay, a magic-system rule that will be tested, a red herring, etc.

Promises are NOT plot beats or scene goals. They are READER EXPECTATIONS the opening creates. Examples:
  - "The detective will solve the murder of her partner" (mystery)
  - "Sarah and Marcus will end up together — or pointedly won't" (romance)
  - "The protagonist will face their estranged father" (confrontation)
  - "The magic costs something, and we'll see what" (magic_rule)
  - "The locked box mentioned on page 3 will be opened" (mystery)

Identify between 3 and 10 promises. Be specific. Skip generic literary themes ("growing up", "loss") — focus on concrete things the reader is now waiting to see resolve.

Return ONLY valid JSON:
{
  "promises": [
    {
      "title": "Short question form: Will X happen?",
      "description": "1-2 sentences on what the opening sets up",
      "category": "mystery" | "romance" | "confrontation" | "transformation" | "world_revelation" | "consequence" | "reunion" | "magic_rule" | "red_herring" | "other",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- DO NOT invent promises that aren't actually set up.
- DO NOT include vague themes ("the importance of family").
- DO mark obvious red herrings as "red_herring" category.
- Output MUST be valid JSON, no code fences, no commentary.`;

const PAYOFF_DETECT_PROMPT = `You are checking whether a single chapter contains a PAYOFF (or partial payoff) for a specific story promise made earlier in the novel.

You will be given:
  - The PROMISE: a question the opening set up
  - The CHAPTER text

Determine whether the chapter:
  - paid_off: the promise is decisively answered / resolved in this chapter
  - partial_payoff: the chapter advances the promise meaningfully toward resolution but doesn't close it
  - touched: the promise is acknowledged but not advanced
  - untouched: the promise isn't engaged with at all

Return ONLY this JSON:
{
  "status": "paid_off" | "partial_payoff" | "touched" | "untouched",
  "confidence": 0.0-1.0,
  "evidence": "1-2 sentence quote or description of where in the chapter this status comes from"
}

No code fences, no commentary outside the JSON.`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class PlotPromisesService {
  private store: Map<string, ProjectPromises> = new Map();
  private storeDir: string;

  constructor(workspaceDir: string) {
    this.storeDir = join(workspaceDir, 'plot-promises');
  }

  async initialize(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
  }

  // ── Persistence ──

  private storePath(projectId: string): string {
    const safeId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return join(this.storeDir, `${safeId}.json`);
  }

  private async load(projectId: string): Promise<ProjectPromises> {
    if (this.store.has(projectId)) return this.store.get(projectId)!;
    const path = this.storePath(projectId);
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw) as ProjectPromises;
        this.store.set(projectId, parsed);
        return parsed;
      } catch { /* fall through */ }
    }
    const empty: ProjectPromises = {
      projectId,
      promises: [],
      extractedAt: null,
      lastEvaluatedAt: null,
    };
    this.store.set(projectId, empty);
    return empty;
  }

  private async persist(projectId: string): Promise<void> {
    const data = this.store.get(projectId);
    if (!data) return;
    try {
      const tmp = this.storePath(projectId) + '.tmp';
      await writeFile(tmp, JSON.stringify(data, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.storePath(projectId));
    } catch (err) {
      console.error('  ✗ Failed to persist plot promises:', err);
    }
  }

  // ── Read API ──

  async getPromises(projectId: string): Promise<ProjectPromises> {
    return this.load(projectId);
  }

  // ── Extraction ──

  /**
   * Extract promises from the opening chapters of a project.
   * Idempotent — re-running replaces the existing promise list (preserving
   * any author confirmations / status updates only if `merge: true`).
   */
  async extractFromOpening(input: {
    projectId: string;
    openingChapterText: string;
    aiComplete: AICompleteFn;
    aiSelectProvider: AISelectProviderFn;
    merge?: boolean;
  }): Promise<ProjectPromises> {
    const project = await this.load(input.projectId);

    const provider = input.aiSelectProvider('revision');
    let raw: string;
    try {
      const response = await input.aiComplete({
        provider: provider.id,
        system: EXTRACT_PROMPT,
        messages: [{
          role: 'user',
          content: input.openingChapterText.slice(0, 30000),
        }],
        maxTokens: 2000,
        temperature: 0.3,
      });
      raw = response.text || '';
    } catch (err) {
      console.warn('  [plot-promises] extraction failed:', (err as Error)?.message || err);
      return project;
    }

    const parsed = this.parseJson(raw);
    if (!parsed?.promises || !Array.isArray(parsed.promises)) {
      console.warn('  [plot-promises] AI returned no usable promises');
      return project;
    }

    const previousById = input.merge
      ? new Map(project.promises.map(p => [p.title.toLowerCase(), p]))
      : new Map();

    const newPromises: PlotPromise[] = parsed.promises
      .filter((p: any) => p?.title && p?.description)
      .map((p: any, idx: number): PlotPromise => {
        const title = String(p.title).slice(0, 200);
        const existing = previousById.get(title.toLowerCase());
        if (existing) {
          // Preserve author edits / status when merging.
          return existing;
        }
        return {
          id: `promise-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          description: String(p.description).slice(0, 500),
          category: this.normalizeCategory(p.category),
          introducedAtChapter: 1, // we extract from opening so always early
          confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.7)),
          status: 'open',
          authorNotes: '',
          touchedAtChapters: [1],
          authorConfirmed: false,
        };
      });

    project.promises = newPromises;
    project.extractedAt = new Date().toISOString();
    project.lastEvaluatedAt = new Date().toISOString();
    await this.persist(input.projectId);
    return project;
  }

  // ── Author actions ──

  async updatePromise(projectId: string, promiseId: string, patch: Partial<PlotPromise>): Promise<PlotPromise | null> {
    const project = await this.load(projectId);
    const idx = project.promises.findIndex(p => p.id === promiseId);
    if (idx < 0) return null;
    // Only allow specific fields to be patched by the author.
    const allowed: (keyof PlotPromise)[] = [
      'title', 'description', 'category', 'status', 'authorNotes',
      'authorConfirmed', 'introducedAtChapter',
    ];
    for (const key of allowed) {
      if (key in patch) (project.promises[idx] as any)[key] = (patch as any)[key];
    }
    if (patch.status === 'paid_off' || patch.status === 'intentionally_unpaid') {
      project.promises[idx].closedAtChapter = patch.closedAtChapter ?? project.promises[idx].closedAtChapter;
      project.promises[idx].closedAtTimestamp = new Date().toISOString();
    }
    await this.persist(projectId);
    return project.promises[idx];
  }

  async deletePromise(projectId: string, promiseId: string): Promise<boolean> {
    const project = await this.load(projectId);
    const before = project.promises.length;
    project.promises = project.promises.filter(p => p.id !== promiseId);
    if (project.promises.length === before) return false;
    await this.persist(projectId);
    return true;
  }

  async addPromise(projectId: string, input: Omit<PlotPromise, 'id' | 'touchedAtChapters'>): Promise<PlotPromise> {
    const project = await this.load(projectId);
    const promise: PlotPromise = {
      id: `promise-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      touchedAtChapters: input.introducedAtChapter ? [input.introducedAtChapter] : [],
      ...input,
    } as PlotPromise;
    project.promises.push(promise);
    await this.persist(projectId);
    return promise;
  }

  // ── Per-chapter payoff detection ──

  /**
   * Run the payoff detector against a single completed chapter for every
   * still-OPEN promise on the project. Updates each promise's status if a
   * payoff (full or partial) is detected.
   */
  async detectPayoffsInChapter(input: {
    projectId: string;
    chapterNumber: number;
    chapterText: string;
    aiComplete: AICompleteFn;
    aiSelectProvider: AISelectProviderFn;
  }): Promise<PlotPromise[]> {
    const project = await this.load(input.projectId);
    const stillOpen = project.promises.filter(
      p => p.status === 'open' || p.status === 'partial_payoff'
    );
    if (stillOpen.length === 0) return [];

    const updated: PlotPromise[] = [];
    const provider = input.aiSelectProvider('consistency');

    // Run detector per-promise. This costs ~one AI call per open promise per
    // chapter — usually 3-8 calls per chapter, cheap on free providers.
    for (const promise of stillOpen) {
      try {
        const response = await input.aiComplete({
          provider: provider.id,
          system: PAYOFF_DETECT_PROMPT,
          messages: [{
            role: 'user',
            content: `PROMISE: ${promise.title}\n\nDescription: ${promise.description}\n\n---\n\nCHAPTER ${input.chapterNumber}:\n\n${input.chapterText.slice(0, 18000)}`,
          }],
          maxTokens: 400,
          temperature: 0.2,
        });

        const parsed = this.parseJson(response.text);
        const status = parsed?.status as string;
        const confidence = Number(parsed?.confidence) || 0;

        if (status === 'paid_off' && confidence > 0.6) {
          promise.status = 'paid_off';
          promise.closedAtChapter = input.chapterNumber;
          promise.closedAtTimestamp = new Date().toISOString();
          promise.touchedAtChapters.push(input.chapterNumber);
          updated.push(promise);
        } else if (status === 'partial_payoff' && confidence > 0.5 && promise.status === 'open') {
          promise.status = 'partial_payoff';
          promise.touchedAtChapters.push(input.chapterNumber);
          updated.push(promise);
        } else if (status === 'touched' && confidence > 0.5) {
          if (!promise.touchedAtChapters.includes(input.chapterNumber)) {
            promise.touchedAtChapters.push(input.chapterNumber);
          }
        }
      } catch (err) {
        console.warn(`  [plot-promises] payoff check failed for "${promise.title}":`, (err as Error)?.message);
      }
    }

    project.lastEvaluatedAt = new Date().toISOString();
    await this.persist(input.projectId);
    return updated;
  }

  // ── Audit ──

  /**
   * Audit a project's promises against current progress. Returns a report
   * highlighting at-risk promises (still open near the end of the manuscript).
   *
   * @param progressPct How far through the manuscript (0-100). Defaults to
   *                    100 (final pass).
   * @param riskThreshold At which progressPct should still-open promises
   *                      start being flagged? (default 80)
   */
  async audit(projectId: string, progressPct: number = 100, riskThreshold: number = 80): Promise<PromiseAuditReport> {
    const project = await this.load(projectId);
    const total = project.promises.length;
    const paidOff = project.promises.filter(p => p.status === 'paid_off').length;
    const partial = project.promises.filter(p => p.status === 'partial_payoff').length;
    const open = project.promises.filter(p => p.status === 'open').length;
    const intentionallyUnpaid = project.promises.filter(p => p.status === 'intentionally_unpaid').length;
    const dropped = project.promises.filter(p => p.status === 'dropped').length;

    const closureRate = total > 0
      ? (paidOff + intentionallyUnpaid) / total
      : 1;

    // Surface at-risk promises only when the project is close to done.
    const atRisk = progressPct >= riskThreshold
      ? project.promises.filter(p => p.status === 'open' || p.status === 'partial_payoff')
      : [];

    let summary: string;
    if (total === 0) {
      summary = 'No promises tracked yet. Run the extractor against your opening chapters.';
    } else if (progressPct < riskThreshold) {
      summary = `${paidOff}/${total} promises paid off, ${partial} partial. Project at ${progressPct}% — risk-flagging will begin at ${riskThreshold}%.`;
    } else if (atRisk.length === 0) {
      summary = `All ${total} promises closed (paid off or intentionally unpaid). Story feels complete.`;
    } else {
      summary = `${atRisk.length} promise${atRisk.length === 1 ? '' : 's'} still open with project at ${progressPct}%. ` +
        `Address them in the climax/resolution, mark them as intentionally unpaid (red herrings often are), or accept the dropped thread.`;
    }

    return {
      projectId, totalPromises: total,
      paidOff, partialPayoff: partial, open,
      intentionallyUnpaid, dropped,
      closureRate: Math.round(closureRate * 100) / 100,
      atRiskPromises: atRisk,
      summary,
    };
  }

  // ── Helpers ──

  private parseJson(text: string): any | null {
    if (!text) return null;
    let cleaned = text
      .replace(/^[\s\S]*?```(?:json|JSON)?\s*/i, m => m.includes('```') ? '' : m)
      .replace(/```[\s\S]*$/, '')
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    cleaned = cleaned.substring(start, end + 1);
    try { return JSON.parse(cleaned); }
    catch {
      try {
        const fixed = cleaned.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(fixed);
      } catch { return null; }
    }
  }

  private normalizeCategory(value: any): PromiseCategory {
    const allowed: PromiseCategory[] = [
      'mystery', 'romance', 'confrontation', 'transformation',
      'world_revelation', 'consequence', 'reunion', 'magic_rule',
      'red_herring', 'other',
    ];
    return allowed.includes(value) ? value : 'other';
  }
}
