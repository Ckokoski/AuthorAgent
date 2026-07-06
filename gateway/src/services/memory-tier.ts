/**
 * AuthorClaw Memory Tier Service
 *
 * The budgeting / reorganization layer over EXISTING memory (Chunk A foundation
 * of the Tiered Memory + Sleep-Time Consolidation design).
 *
 * This service does NOT own a second copy of any data. It is a pure read +
 * budget layer over:
 *   - ContextEngine (chapter summaries, entity index) — raw material for CORE.
 *   - MemorySearchService (FTS5 BM25) — ARCHIVAL tier, on-demand.
 *   - A small materialized digest ({projectId}-core.json) written by the sleep
 *     job (Chunk C) and read on the hot path.
 *
 * Governing principle: never remove injected context without a summary
 * replacing it. Everything here is additive or a lossless-enough swap.
 *
 * The CORE tier is assembled per the design's priority table:
 *   P1 active chapter state  (≤500)
 *   P2 promoted char sheets  (≤1400, cap ~6)
 *   P3 open plot threads     (≤700)
 *   P4 style digest          (≤600)
 *   P5 active world rules    (≤300)
 *   TOTAL hard-clamped to 3,500 chars.
 *
 * Greedy best-fit, whole-item-or-skip: an item is added in full or skipped
 * entirely — sheets are never truncated mid-item. Empty slots are skipped
 * silently.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

import type { ContextEngine, ChapterSummary, EntityEntry } from './context-engine.js';
import type { MemorySearchService } from './memory-search.js';

// ═══════════════════════════════════════════════════════════
// Budgets
// ═══════════════════════════════════════════════════════════

/** Per-priority character budgets and the hard total clamp for the CORE block. */
export const CORE_BUDGETS = {
  total: 3500,
  p1ActiveChapter: 500,
  p2CharacterSheets: 1400,
  p3PlotThreads: 700,
  p4StyleDigest: 600,
  p5WorldRules: 300,
} as const;

/** Max character sheets promoted into CORE (design: cap ~6). */
export const PROMOTED_SHEET_CAP = 6;

/** Baseline top-K most-recurring characters always considered for promotion. */
export const PROMOTE_BASELINE_K = 4;

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

/**
 * Materialized digest written by the sleep job (Chunk C) and read on the hot
 * path. Every field is optional — a missing digest (or a partial one) must
 * degrade gracefully to live ContextEngine reads.
 */
export interface CoreDigest {
  /** Distilled style digest (≤600 chars), sourced from SOUL/STYLE/VOICE. */
  styleDigest?: string;
  /** Threads the sleep job classified as still open. */
  openThreads?: string[];
  /** Threads the sleep job classified as resolved (excluded from CORE). */
  resolvedThreads?: string[];
  /** Names of the baseline top-K recurring characters pre-promoted by the job. */
  promotedBaseline?: string[];
  /** Per-character 1–2 sentence arc summaries, keyed by character name. */
  arcs?: Record<string, string>;
  /** ISO timestamp of when this digest was computed. */
  computedAt?: string;
}

/** Options for the (Chunk B) archival search. */
export interface ArchivalOptions {
  limit?: number;
  personaId?: string | null;
  projectId?: string;
  maxChars?: number;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class MemoryTierService {
  private contextEngine: ContextEngine;
  private memorySearch: MemorySearchService | null;
  private workspaceDir: string;

  constructor(
    contextEngine: ContextEngine,
    memorySearch: MemorySearchService | null,
    workspaceDir: string,
  ) {
    this.contextEngine = contextEngine;
    this.memorySearch = memorySearch;
    this.workspaceDir = workspaceDir;
  }

  // ── CORE assembly ────────────────────────────────────────

  /**
   * Assemble the CORE block for a project, budgeted per the design's priority
   * table and hard-clamped to CORE_BUDGETS.total chars.
   *
   * Pure read + budget — never AI-calls, never throws. Returns '' when nothing
   * is cached (empty ProjectContext, no summaries and no entities).
   *
   * Greedy addPart pattern: each slot's rendered block is added whole if it
   * fits the remaining total budget, or skipped entirely. Individual slots are
   * pre-trimmed to their own per-priority budget by whole-item-or-skip logic
   * (never truncate mid-sheet).
   */
  buildCore(projectId: string, activeChapterNumber: number, promptText: string): string {
    const summaries = this.getSummaries(projectId);
    const entities = this.contextEngine.getEntities(projectId);

    // Nothing cached at all → empty CORE (never throw).
    if (summaries.length === 0 && entities.length === 0) return '';

    const digest = this.loadCoreDigest(projectId);

    const sections: string[] = [];
    let remaining = CORE_BUDGETS.total;

    // Greedy: add `block` in full if it fits the remaining TOTAL budget.
    const addPart = (block: string): void => {
      if (!block) return;
      if (block.length > remaining) return; // whole-item-or-skip
      sections.push(block);
      remaining -= block.length;
    };

    // ── P1: active chapter state (≤500) ──
    addPart(this.buildActiveChapterBlock(summaries, activeChapterNumber));

    // ── P2: promoted character sheets (≤1400, cap ~6) ──
    const promoted = this.getPromotedSet(projectId, activeChapterNumber, promptText);
    addPart(this.buildCharacterSheetsBlock(promoted, digest));

    // ── P3: open plot threads (≤700) ──
    addPart(this.buildPlotThreadsBlock(projectId, digest));

    // ── P4: style digest (≤600) ──
    addPart(this.buildStyleDigestBlock(digest));

    // ── P5: active world rules (≤300) ──
    addPart(this.buildWorldRulesBlock(projectId));

    if (sections.length === 0) return '';

    const body = sections.join('\n\n');
    const block = `# CORE STORY MEMORY\n\n${body}`;
    // Final hard clamp — the header + joins can only push us over the total by
    // a bounded amount; clamp defensively so the contract (≤ total) always holds.
    return block.length > CORE_BUDGETS.total
      ? block.substring(0, CORE_BUDGETS.total)
      : block;
  }

  /** P1 — the active chapter's ending state / summary, capped at p1 budget. */
  private buildActiveChapterBlock(
    summaries: ChapterSummary[],
    activeChapterNumber: number,
  ): string {
    if (summaries.length === 0) return '';

    // Prefer the summary for the chapter immediately BEFORE the active one
    // (the most recent completed state), falling back to the latest available.
    const prior = summaries
      .filter(s => s.chapterNumber < activeChapterNumber)
      .sort((a, b) => b.chapterNumber - a.chapterNumber)[0];
    const chapter = prior ?? summaries[summaries.length - 1];
    if (!chapter) return '';

    const state = (chapter.endingState || chapter.summary || '').trim();
    if (!state) return '';

    const heading = `## Active Chapter State\n**Ch ${chapter.chapterNumber} — ${chapter.title}**`;
    const full = `${heading}\n${state}`;
    if (full.length <= CORE_BUDGETS.p1ActiveChapter) return full;

    // Over the P1 budget: trim the free-text state (not the heading) to fit.
    // This is a within-slot trim of a single narrative string, not a
    // multi-item list, so a mid-string cut is acceptable here (P1 is a single
    // "where things stand" blob, never a set of whole sheets).
    const room = CORE_BUDGETS.p1ActiveChapter - heading.length - 1;
    if (room <= 0) return heading.substring(0, CORE_BUDGETS.p1ActiveChapter);
    return `${heading}\n${state.substring(0, Math.max(0, room)).trimEnd()}`;
  }

  /** P2 — promoted character sheets, whole-item-or-skip within the p2 budget. */
  private buildCharacterSheetsBlock(promoted: EntityEntry[], digest: CoreDigest | null): string {
    if (promoted.length === 0) return '';

    const lines: string[] = [];
    let used = 0;
    const heading = '## Key Characters';
    // Budget is for the character lines; the heading is small and always kept
    // if at least one sheet fits.
    for (const c of promoted) {
      const line = this.renderCharacterSheet(c, digest);
      // whole-item-or-skip: never truncate a sheet mid-item.
      if (used + line.length + 1 > CORE_BUDGETS.p2CharacterSheets) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';
    return `${heading}\n${lines.join('\n')}`;
  }

  /** Render one character sheet as a single markdown line. */
  private renderCharacterSheet(c: EntityEntry, digest: CoreDigest | null): string {
    const arc = digest?.arcs?.[c.name];
    const attrs = Object.entries(c.attributes ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const desc = arc || c.description || '';
    const attrSuffix = attrs ? ` (${attrs})` : '';
    return `- **${c.name}**: ${desc}${attrSuffix}`;
  }

  /**
   * P3 — open plot threads. Prefers the sleep-job digest's openThreads (which
   * has already excluded resolved threads); falls back to the live union from
   * ContextEngine. Whole-item-or-skip within the p3 budget.
   */
  private buildPlotThreadsBlock(projectId: string, digest: CoreDigest | null): string {
    let threads: string[] = [];
    if (digest?.openThreads && digest.openThreads.length > 0) {
      threads = digest.openThreads;
    } else {
      const resolved = new Set((digest?.resolvedThreads ?? []).map(t => t.trim().toLowerCase()));
      threads = this.contextEngine
        .getOpenPlotThreads(projectId)
        .filter(t => !resolved.has(t.trim().toLowerCase()));
    }
    threads = threads.map(t => (t ?? '').trim()).filter(Boolean);
    if (threads.length === 0) return '';

    const heading = '## Open Plot Threads';
    const lines: string[] = [];
    let used = 0;
    for (const t of threads) {
      const line = `- ${t}`;
      if (used + line.length + 1 > CORE_BUDGETS.p3PlotThreads) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';
    return `${heading}\n${lines.join('\n')}`;
  }

  /**
   * P4 — style digest. Precedence: digest.styleDigest, else first 600 chars of
   * workspace/soul/STYLE-GUIDE.md if it exists, else nothing.
   */
  private buildStyleDigestBlock(digest: CoreDigest | null): string {
    let style = (digest?.styleDigest ?? '').trim();
    if (!style) {
      style = this.readStyleGuideFallback().trim();
    }
    if (!style) return '';

    const heading = '## Style Digest';
    const room = CORE_BUDGETS.p4StyleDigest - heading.length - 1;
    const body = style.length > room ? style.substring(0, Math.max(0, room)).trimEnd() : style;
    if (!body) return '';
    return `${heading}\n${body}`;
  }

  /** Read and cap the STYLE-GUIDE.md fallback. Never throws. */
  private readStyleGuideFallback(): string {
    try {
      const path = join(this.workspaceDir, 'soul', 'STYLE-GUIDE.md');
      if (!existsSync(path)) return '';
      const raw = readFileSync(path, 'utf-8');
      return raw.substring(0, CORE_BUDGETS.p4StyleDigest);
    } catch {
      return '';
    }
  }

  /** P5 — active world rules (rule-type entities), whole-item-or-skip within budget. */
  private buildWorldRulesBlock(projectId: string): string {
    const rules = this.contextEngine.getEntitiesByType(projectId, 'rule');
    if (rules.length === 0) return '';

    const heading = '## World Rules';
    const lines: string[] = [];
    let used = 0;
    for (const r of rules) {
      const desc = (r.description || '').trim();
      const line = `- **${r.name}**: ${desc}`;
      if (used + line.length + 1 > CORE_BUDGETS.p5WorldRules) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';
    return `${heading}\n${lines.join('\n')}`;
  }

  // ── PROMOTE / DEMOTE ─────────────────────────────────────

  /**
   * Compute the promoted set of character sheets for CORE.
   *
   * PROMOTE rule: a character is promoted if its name/alias appears
   * (case-insensitive) in the active chapter's summary text, its plotThreads,
   * or the promptText — PLUS a baseline of the top-K most-recurring characters
   * (by total appearances across summaries + change-log entries).
   *
   * DEMOTE (budget-driven): the set is capped at PROMOTED_SHEET_CAP and then,
   * if the rendered sheets would exceed the P2 budget, the lowest-relevance
   * WHOLE sheets (fewest recent appearances) are dropped first — never a
   * mid-sheet truncation.
   */
  getPromotedSet(
    projectId: string,
    activeChapterNumber: number,
    promptText: string,
  ): EntityEntry[] {
    const characters = this.contextEngine.getEntitiesByType(projectId, 'character');
    if (characters.length === 0) return [];

    const summaries = this.getSummaries(projectId);
    const digest = this.loadCoreDigest(projectId);

    // Build the active chapter's match haystack: summary text + plotThreads +
    // prompt. Case-insensitive substring matching against name/alias.
    const active = summaries.find(s => s.chapterNumber === activeChapterNumber);
    const haystackParts: string[] = [promptText ?? ''];
    if (active) {
      haystackParts.push(active.summary ?? '', ...(active.plotThreads ?? []));
    }
    const haystack = haystackParts.join(' \n ').toLowerCase();

    // Appearance count = how often the character shows up across all summaries'
    // character lists + its own change-log length. Drives baseline top-K and
    // relevance-based demotion.
    const appearances = new Map<string, number>();
    for (const c of characters) {
      appearances.set(c.name, this.countAppearances(c, summaries));
    }

    // Baseline top-K by appearances (design: K=4). Digest's promotedBaseline,
    // when present, takes precedence as the pre-computed baseline.
    const baselineNames = new Set<string>();
    if (digest?.promotedBaseline && digest.promotedBaseline.length > 0) {
      for (const n of digest.promotedBaseline) baselineNames.add(n.toLowerCase());
    } else {
      const ranked = [...characters].sort(
        (a, b) => (appearances.get(b.name) ?? 0) - (appearances.get(a.name) ?? 0),
      );
      for (const c of ranked.slice(0, PROMOTE_BASELINE_K)) {
        baselineNames.add(c.name.toLowerCase());
      }
    }

    // Select: name/alias mentioned in haystack OR in the baseline set.
    const selected = characters.filter(c => {
      if (baselineNames.has(c.name.toLowerCase())) return true;
      if (this.mentioned(c, haystack)) return true;
      return false;
    });

    // Rank by relevance for capping + demotion: mentioned-in-haystack first
    // (higher relevance), then by appearance count. This ensures an
    // unreferenced minor baseline character is the first to be dropped when
    // over budget.
    const relevance = (c: EntityEntry): number => {
      const mentionBoost = this.mentioned(c, haystack) ? 1_000_000 : 0;
      return mentionBoost + (appearances.get(c.name) ?? 0);
    };
    const ranked = [...selected].sort((a, b) => relevance(b) - relevance(a));

    // Cap at PROMOTED_SHEET_CAP whole sheets.
    let promoted = ranked.slice(0, PROMOTED_SHEET_CAP);

    // Budget-driven demotion: drop lowest-relevance WHOLE sheets until the
    // rendered block fits the P2 budget.
    while (promoted.length > 0 && this.renderedSheetsLength(promoted, digest) > CORE_BUDGETS.p2CharacterSheets) {
      promoted = promoted.slice(0, promoted.length - 1);
    }

    return promoted;
  }

  /** Alias for getPromotedSet — the design refers to this as `promote()`. */
  promote(projectId: string, activeChapterNumber: number, promptText: string): EntityEntry[] {
    return this.getPromotedSet(projectId, activeChapterNumber, promptText);
  }

  /** True if the character's name or any alias appears in the lowercased haystack. */
  private mentioned(c: EntityEntry, lowerHaystack: string): boolean {
    if (!lowerHaystack) return false;
    const name = c.name?.toLowerCase().trim();
    if (name && lowerHaystack.includes(name)) return true;
    for (const alias of c.aliases ?? []) {
      const a = alias?.toLowerCase().trim();
      if (a && lowerHaystack.includes(a)) return true;
    }
    return false;
  }

  /** Total appearances across summary character lists + change-log entries. */
  private countAppearances(c: EntityEntry, summaries: ChapterSummary[]): number {
    const names = new Set<string>([c.name.toLowerCase().trim()]);
    for (const alias of c.aliases ?? []) names.add(alias.toLowerCase().trim());
    let count = 0;
    for (const s of summaries) {
      for (const ch of s.characters ?? []) {
        if (names.has(ch.toLowerCase().trim())) count++;
      }
    }
    count += (c.changes ?? []).length;
    return count;
  }

  /** Length of the rendered character sheets block body (lines only). */
  private renderedSheetsLength(promoted: EntityEntry[], digest: CoreDigest | null): number {
    let len = 0;
    for (const c of promoted) len += this.renderCharacterSheet(c, digest).length + 1;
    return len;
  }

  // ── Core digest r/w ──────────────────────────────────────

  private coreDigestPath(projectId: string): string {
    return join(this.workspaceDir, 'context', `${projectId}-core.json`);
  }

  /**
   * Read the materialized core digest. Never throws — returns null on missing
   * file or malformed JSON so the hot path degrades to live reads.
   */
  loadCoreDigest(projectId: string): CoreDigest | null {
    try {
      const path = this.coreDigestPath(projectId);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as CoreDigest;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Write the materialized core digest atomically (tmp + rename). Best-effort:
   * ensures the context dir exists first. Throws only on a genuine write
   * failure the caller should surface (the sleep job wraps each pass in
   * try/catch).
   */
  writeCoreDigest(projectId: string, digest: CoreDigest): void {
    const finalPath = this.coreDigestPath(projectId);
    const dir = join(this.workspaceDir, 'context');
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    const payload: CoreDigest = { ...digest, computedAt: digest.computedAt ?? new Date().toISOString() };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, finalPath);
  }

  // ── ARCHIVAL (Chunk B — thin stub here) ──────────────────

  /**
   * Search the ARCHIVAL tier (FTS5 BM25 over conversations + manuscripts +
   * project steps) and return a labeled, budgeted excerpt block.
   *
   * TODO(Chunk B): full implementation — format hits into a
   * "# From Your Manuscript & Past Work" section, budget ≤2,000 chars, label
   * as excerpts, wire persona/project scoping. For Chunk A this is a thin stub
   * that returns '' when memorySearch is null (graceful degradation) and
   * otherwise returns '' as well until the Chunk B formatter lands.
   */
  searchArchival(query: string, opts: ArchivalOptions = {}): string {
    if (!this.memorySearch || !this.memorySearch.isAvailable()) return '';
    // TODO(Chunk B): call this.memorySearch.search(query, {...}) and format the
    // hits into a budgeted, labeled excerpt block. Intentionally inert in
    // Chunk A so no hot path can depend on it yet.
    void query;
    void opts;
    return '';
  }

  // ── Internal helpers ─────────────────────────────────────

  /** Cached summaries for a project (chapter-sorted by ContextEngine). */
  private getSummaries(projectId: string): ChapterSummary[] {
    return this.contextEngine.getSummaries(projectId);
  }
}
