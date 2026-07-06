/**
 * AuthorClaw Skill Curator (Hermes-pattern)
 *
 * A consolidation pass that keeps the ~34-skill library healthy. It reads the
 * loaded skill catalog + the usage stats logged by SkillLoader.matchSkills and
 * produces a READ-ONLY report of maintenance proposals — it NEVER deletes or
 * rewrites a skill. The author acts on the proposals.
 *
 * Three signals, all cheap:
 *   1. UNUSED    — skills matched 0 times (report, don't delete).
 *   2. OVERLAPPING — skill pairs whose triggers/descriptions are highly similar
 *      (token Jaccard + character n-gram, NON-AI). Proposes which to keep.
 *   3. REDUNDANT-WITH-SERVICE — a markdown skill whose purpose duplicates an
 *      existing gateway service route (the known split-brain being the
 *      `style-clone` markdown skill vs the StyleCloneService / /api/style-clone
 *      analyzer). Flags it with a concrete "point the skill at the service"
 *      recommendation.
 *
 * An OPTIONAL single free-tier AI call summarizes/prioritizes the proposals.
 * It is fully guarded: no AI wired, no AI available, or a thrown call all
 * degrade to a deterministic non-AI summary. Every AI request resolves to the
 * FREE tier only ('general'/'research'), mirroring SleepConsolidationService's
 * cost rule.
 *
 * curate() NEVER throws — every sub-step is guarded and failures degrade to an
 * empty/partial section.
 */

import type { SkillLoader, SkillCatalogEntry, SkillUsageStat } from '../skills/loader.js';

// ═══════════════════════════════════════════════════════════
// Injected AI closures (same shape as sleep-consolidation)
// ═══════════════════════════════════════════════════════════

/** AI completion closure — identical shape to the router's complete(). */
export type CuratorAICompleteFn = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

/** Provider selection closure. Widened to expose `tier` for the cost-rule guard. */
export type CuratorAISelectProviderFn = (taskType: string) => { id: string; tier?: string };

// ═══════════════════════════════════════════════════════════
// Report types
// ═══════════════════════════════════════════════════════════

export interface UnusedSkill {
  name: string;
  category: string;
  description: string;
  /** Never-used vs. last used before the staleness threshold. */
  reason: 'never-used' | 'stale';
  lastUsedIso: string | null;
}

export interface OverlappingPair {
  a: string;
  b: string;
  /** 0..1 blended similarity (trigger Jaccard + description n-gram). */
  similarity: number;
  recommendation: string;
}

export interface RedundantWithService {
  skill: string;
  service: string;
  route: string;
  recommendation: string;
}

export interface CurationReport {
  generatedAt: string;
  totalSkills: number;
  unused: UnusedSkill[];
  overlapping: OverlappingPair[];
  redundantWithService: RedundantWithService[];
  /** Human-readable prioritization. AI-written when available, else derived. */
  summary: string;
  /** True when the summary came from a free-tier AI call. */
  aiSummary: boolean;
}

export interface CurateOptions {
  /** Days of inactivity before a used skill counts as "stale". Default 30. */
  staleAfterDays?: number;
  /** Similarity threshold [0..1] to flag an overlapping pair. Default 0.6. */
  overlapThreshold?: number;
  /** Set false to skip the optional AI summary even when AI is wired. Default true. */
  useAI?: boolean;
}

// ═══════════════════════════════════════════════════════════
// Tuning
// ═══════════════════════════════════════════════════════════

const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_OVERLAP_THRESHOLD = 0.6;
const SUMMARY_TOKENS = 400;
const FREE_TASK_TYPES = new Set(['general', 'research', 'marketing']);

/**
 * Known service-backed duplications. Each entry names a markdown skill whose
 * job is already done (better) by a gateway service + HTTP route. Generalizes
 * the style-clone split-brain: add rows here as more services subsume skills.
 */
const KNOWN_SERVICE_REDUNDANCIES: Array<{
  skill: string;
  service: string;
  route: string;
  recommendation: string;
}> = [
  {
    skill: 'style-clone',
    service: 'StyleCloneService',
    route: 'POST /api/style-clone/analyze',
    recommendation:
      'The gateway already computes a 47-marker voice profile via StyleCloneService ' +
      '(POST /api/style-clone/analyze, or POST /api/projects/:id/style-clone for a whole ' +
      'project). Rewrite skills/author/style-clone/SKILL.md to CALL that service and save ' +
      'the returned profile, instead of describing a parallel freeform markdown-only ' +
      'analysis — otherwise the two drift and the skill produces a worse, unquantified result.',
  },
];

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class SkillCuratorService {
  private skills: SkillLoader;
  private aiComplete: CuratorAICompleteFn | null;
  private aiSelectProvider: CuratorAISelectProviderFn | null;

  /**
   * @param skills           The live SkillLoader (source of catalog + usage).
   * @param aiComplete       Optional. Wire to enable the free-tier AI summary.
   * @param aiSelectProvider Optional. Must accompany aiComplete to select a
   *                         free-tier provider; the pair is used together.
   */
  constructor(
    skills: SkillLoader,
    aiComplete?: CuratorAICompleteFn,
    aiSelectProvider?: CuratorAISelectProviderFn,
  ) {
    this.skills = skills;
    this.aiComplete = aiComplete ?? null;
    this.aiSelectProvider = aiSelectProvider ?? null;
  }

  /**
   * Produce a CurationReport. Never throws — each section is independently
   * guarded and degrades to empty on failure.
   */
  async curate(opts: CurateOptions = {}): Promise<CurationReport> {
    const generatedAt = new Date().toISOString();
    const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
    const overlapThreshold = opts.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
    const useAI = opts.useAI !== false;

    let catalog: SkillCatalogEntry[] = [];
    let usage: Record<string, SkillUsageStat> = {};
    try {
      catalog = this.skills.getSkillCatalog() || [];
    } catch { catalog = []; }
    try {
      usage = this.skills.getUsageStats() || {};
    } catch { usage = {}; }

    const unused = this.safe(() => this.detectUnused(catalog, usage, staleAfterDays), []);
    const overlapping = this.safe(() => this.detectOverlapping(catalog, overlapThreshold), []);
    const redundantWithService = this.safe(() => this.detectServiceRedundancy(catalog), []);

    // Deterministic summary first — always present even if AI is skipped/fails.
    let summary = this.buildDeterministicSummary(catalog.length, unused, overlapping, redundantWithService);
    let aiSummary = false;
    if (useAI && this.aiComplete && this.aiSelectProvider) {
      const ai = await this.maybeAISummary(catalog.length, unused, overlapping, redundantWithService);
      if (ai) { summary = ai; aiSummary = true; }
    }

    return {
      generatedAt,
      totalSkills: catalog.length,
      unused,
      overlapping,
      redundantWithService,
      summary,
      aiSummary,
    };
  }

  // ── Section 1: unused ──────────────────────────────────────

  private detectUnused(
    catalog: SkillCatalogEntry[],
    usage: Record<string, SkillUsageStat>,
    staleAfterDays: number,
  ): UnusedSkill[] {
    const now = Date.now();
    const staleMs = staleAfterDays * 86400000;
    const out: UnusedSkill[] = [];
    for (const s of catalog) {
      const stat = usage[s.name];
      if (!stat || stat.count <= 0) {
        out.push({ name: s.name, category: s.category, description: s.description, reason: 'never-used', lastUsedIso: null });
        continue;
      }
      // Used at least once, but not recently → stale.
      const last = stat.lastUsedIso ? Date.parse(stat.lastUsedIso) : NaN;
      if (Number.isFinite(last) && now - last > staleMs) {
        out.push({ name: s.name, category: s.category, description: s.description, reason: 'stale', lastUsedIso: stat.lastUsedIso });
      }
    }
    return out;
  }

  // ── Section 2: overlapping pairs ───────────────────────────

  private detectOverlapping(catalog: SkillCatalogEntry[], threshold: number): OverlappingPair[] {
    const pairs: OverlappingPair[] = [];
    for (let i = 0; i < catalog.length; i++) {
      for (let j = i + 1; j < catalog.length; j++) {
        const a = catalog[i];
        const b = catalog[j];
        const similarity = this.skillSimilarity(a, b);
        if (similarity >= threshold) {
          pairs.push({
            a: a.name,
            b: b.name,
            similarity: Math.round(similarity * 1000) / 1000,
            recommendation: this.mergeRecommendation(a, b, similarity),
          });
        }
      }
    }
    // Highest-similarity pairs first.
    pairs.sort((x, y) => y.similarity - x.similarity);
    return pairs;
  }

  /**
   * Blended similarity in [0..1]:
   *   0.65 * token-Jaccard(triggers ∪ triggers) + 0.35 * char-trigram Jaccard(descriptions).
   * Triggers dominate because they define WHEN a skill fires (the real overlap
   * risk); descriptions are a softer, fuzzier signal via n-grams so paraphrases
   * still register. Pure string ops — no AI.
   */
  private skillSimilarity(a: SkillCatalogEntry, b: SkillCatalogEntry): number {
    const trigA = this.triggerTokens(a.triggers);
    const trigB = this.triggerTokens(b.triggers);
    const trigJ = jaccard(trigA, trigB);

    const descA = charNGrams(normalize(a.description), 3);
    const descB = charNGrams(normalize(b.description), 3);
    const descJ = jaccard(descA, descB);

    return 0.65 * trigJ + 0.35 * descJ;
  }

  /** Flatten triggers into a set of normalized word tokens. */
  private triggerTokens(triggers: string[]): Set<string> {
    const set = new Set<string>();
    for (const t of triggers || []) {
      for (const tok of normalize(t).split(' ')) {
        if (tok.length >= 3) set.add(tok);
      }
    }
    return set;
  }

  private mergeRecommendation(a: SkillCatalogEntry, b: SkillCatalogEntry, similarity: number): string {
    // Prefer keeping the richer skill (more triggers → broader coverage); tie
    // breaks alphabetically for determinism.
    const aScore = (a.triggers?.length ?? 0);
    const bScore = (b.triggers?.length ?? 0);
    let keep: string, merge: string;
    if (aScore !== bScore) {
      keep = aScore > bScore ? a.name : b.name;
      merge = aScore > bScore ? b.name : a.name;
    } else {
      keep = a.name < b.name ? a.name : b.name;
      merge = a.name < b.name ? b.name : a.name;
    }
    const pct = Math.round(similarity * 100);
    return `~${pct}% overlap. Consider merging "${merge}" into "${keep}" (fold its triggers/body in) and deleting the duplicate, or narrow their triggers so they don't both fire on the same input.`;
  }

  // ── Section 3: service redundancy ──────────────────────────

  private detectServiceRedundancy(catalog: SkillCatalogEntry[]): RedundantWithService[] {
    const present = new Set(catalog.map(s => s.name));
    const out: RedundantWithService[] = [];
    for (const row of KNOWN_SERVICE_REDUNDANCIES) {
      if (present.has(row.skill)) {
        out.push({ skill: row.skill, service: row.service, route: row.route, recommendation: row.recommendation });
      }
    }
    return out;
  }

  // ── Optional free-tier AI summary ──────────────────────────

  /**
   * ONE free-tier AI call to prioritize the proposals. Returns null (caller
   * keeps the deterministic summary) when: AI isn't wired, the resolved
   * provider isn't free tier, there's nothing to summarize, or the call throws.
   */
  private async maybeAISummary(
    total: number,
    unused: UnusedSkill[],
    overlapping: OverlappingPair[],
    redundant: RedundantWithService[],
  ): Promise<string | null> {
    if (!this.aiComplete || !this.aiSelectProvider) return null;
    if (unused.length === 0 && overlapping.length === 0 && redundant.length === 0) return null;

    // Cost-rule gate: resolve a FREE provider or bail (never spend a paid call).
    let provider: { id: string; tier?: string };
    try {
      provider = this.resolveFreeProvider('general');
    } catch {
      return null;
    }

    const system =
      'You are a maintenance analyst for an AI writing agent\'s skill library. ' +
      'Given lists of unused skills, overlapping skill pairs, and skills that ' +
      'duplicate a backend service, write a SHORT prioritized action brief ' +
      '(plain prose, at most 6 sentences). Lead with the highest-impact, ' +
      'lowest-risk fixes. Do not invent skills not listed. No markdown headings.';
    const user =
      `Total skills: ${total}\n\n` +
      `UNUSED (${unused.length}):\n${unused.map(u => `- ${u.name} (${u.reason})`).join('\n') || '- none'}\n\n` +
      `OVERLAPPING (${overlapping.length}):\n${overlapping.map(o => `- ${o.a} ~ ${o.b} (${o.similarity})`).join('\n') || '- none'}\n\n` +
      `REDUNDANT WITH SERVICE (${redundant.length}):\n${redundant.map(r => `- ${r.skill} duplicates ${r.service} (${r.route})`).join('\n') || '- none'}`;

    try {
      const res = await this.aiComplete({
        provider: provider.id,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: SUMMARY_TOKENS,
        temperature: 0.2,
      });
      const text = (res?.text || '').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a provider for a free-tier task type, THROWING if the router hands
   * back a non-free provider (fail closed on any cost-rule breach). Mirrors
   * SleepConsolidationService.resolveFreeProvider.
   */
  private resolveFreeProvider(taskType: 'general' | 'research' | 'marketing'): { id: string; tier?: string } {
    if (!FREE_TASK_TYPES.has(taskType)) {
      throw new Error(`cost-rule: task type "${taskType}" is not free-tier`);
    }
    const provider = this.aiSelectProvider!(taskType);
    if (provider.tier && provider.tier !== 'free') {
      throw new Error(`cost-rule: provider "${provider.id}" resolved to non-free tier "${provider.tier}"`);
    }
    return provider;
  }

  // ── Deterministic summary (always available) ───────────────

  private buildDeterministicSummary(
    total: number,
    unused: UnusedSkill[],
    overlapping: OverlappingPair[],
    redundant: RedundantWithService[],
  ): string {
    const parts: string[] = [`${total} skill(s) reviewed.`];
    if (redundant.length > 0) {
      parts.push(`${redundant.length} skill(s) duplicate a backend service (highest priority — point the skill at the service): ${redundant.map(r => r.skill).join(', ')}.`);
    }
    if (overlapping.length > 0) {
      parts.push(`${overlapping.length} overlapping pair(s) worth consolidating (top: ${overlapping[0].a} ~ ${overlapping[0].b} at ${overlapping[0].similarity}).`);
    }
    if (unused.length > 0) {
      parts.push(`${unused.length} skill(s) show no recent usage: ${unused.slice(0, 8).map(u => u.name).join(', ')}${unused.length > 8 ? ', …' : ''}.`);
    }
    if (redundant.length === 0 && overlapping.length === 0 && unused.length === 0) {
      parts.push('No unused, overlapping, or service-redundant skills detected — the library looks healthy.');
    }
    return parts.join(' ');
  }

  // ── util ───────────────────────────────────────────────────

  /** Run a section body, returning `fallback` (never throwing) on error. */
  private safe<T>(body: () => T, fallback: T): T {
    try { return body(); } catch { return fallback; }
  }
}

// ═══════════════════════════════════════════════════════════
// Similarity helpers (module-scoped, pure)
// ═══════════════════════════════════════════════════════════

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity of two sets: |A∩B| / |A∪B|. Empty ∪ empty = 0. */
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Character n-gram set of a normalized string. Short strings → whole string. */
function charNGrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  const compact = s.replace(/\s+/g, ' ');
  if (compact.length < n) {
    if (compact) out.add(compact);
    return out;
  }
  for (let i = 0; i <= compact.length - n; i++) {
    out.add(compact.slice(i, i + n));
  }
  return out;
}
