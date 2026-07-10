/**
 * Chunk B2 integration tests: the tiered-memory wiring into the CHAT path
 * (MessagePipeline.buildSystemPrompt, reached through handleMessage).
 *
 * Contract under test (additive + guarded):
 *   - CHAT CORE: the "# Story Memory (Core)" block appears when there is an
 *     active project AND a memoryTier wired, and is ABSENT (byte-identical to
 *     before) when the tier is unwired.
 *   - ARCHIVAL RECALL: the "# From Your Manuscript & Past Work" block is spliced
 *     into chat from the FTS archive, after the existing book-bible memory, and
 *     is absent when memorySearch is unavailable.
 *   - TOTAL BUDGET GUARD: when the assembled prompt overruns the soft cap, the
 *     lowest-priority already-capped sections are dropped in a fixed order
 *     (lessons → preferences → user-model → archival) while soul / CORE /
 *     active-project / security are always retained.
 *
 * Approach: drive the real handleMessage() with a minimal fake ServiceContainer
 * and a stub aiRouter whose complete() captures the assembled `system` string.
 * This exercises the true assembly + guard code, not a reimplementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine, type ProjectContext } from './context-engine.js';
import { MemoryTierService } from './memory-tier.js';
import type { MemorySearchService, SearchHit } from './memory-search.js';
import { MessagePipeline } from './message-pipeline.js';
import type { ServiceContainer } from './container.js';

// ═══════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════

let rootDir: string;
let workspaceDir: string;
let engine: ContextEngine;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'authoragent-b2-'));
  workspaceDir = join(rootDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  engine = new ContextEngine(workspaceDir);
});

afterEach(() => {
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Seed a ContextEngine cache (on disk + loaded) with two chapter summaries. */
async function seedSummaries(projectId: string): Promise<void> {
  const ctx: ProjectContext = {
    projectId,
    updatedAt: new Date().toISOString(),
    summaries: [
      {
        chapterId: `${projectId}-w1`, chapterNumber: 1, title: 'The Gathering Storm',
        summary: 'Aria meets Kael at the docks.', wordCount: 3000,
        characters: ['Aria', 'Kael'], locations: ['The Docks'], timelineMarker: 'Day 1',
        plotThreads: ['the missing heir'],
        endingState: 'Aria sets sail into the storm, uncertain whom to trust.',
      },
      {
        chapterId: `${projectId}-w2`, chapterNumber: 2, title: 'The Sealed Vault',
        summary: 'Aria and Mira open the vault; Doran ambushes them.', wordCount: 3200,
        characters: ['Aria', 'Mira', 'Doran'], locations: ['The Vault'], timelineMarker: 'Day 3',
        plotThreads: ['the sealed vault'],
        endingState: 'CORE_CH2_ENDING_MARKER: Doran holds them at swordpoint.',
      },
    ],
    entities: [
      {
        name: 'Aria', type: 'character', aliases: [],
        description: 'A dockside courier searching for the truth.',
        firstAppearance: `${projectId}-w1`, lastSeen: `${projectId}-w2`,
        attributes: { role: 'protagonist' }, changes: [],
      },
    ],
  };
  const contextDir = join(workspaceDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, `${projectId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
  await engine.loadContext(projectId);
}

/** A fake MemorySearchService returning a fixed manuscript hit for any query. */
function fakeSearch(hits: SearchHit[] = defaultHits()): MemorySearchService {
  return {
    isAvailable: () => true,
    search: (_q: string, _opts: any): SearchHit[] => hits,
  } as unknown as MemorySearchService;
}
function defaultHits(): SearchHit[] {
  return [{
    id: 1, source: 'manuscript', sourceRef: 'ch3.md', personaId: null, projectId: null,
    timestamp: '2026-01-02T00:00:00Z', title: 'Chapter 3 — The Reckoning',
    snippet: 'ARCHIVAL_MANUSCRIPT_HIT: the reckoning begins at dawn', rank: -5,
  }];
}

/**
 * Build a minimal fake ServiceContainer covering exactly the members
 * handleMessage() touches on the happy path. `overrides` lets a test swap in a
 * memoryTier / contextEngine / activeProject etc. `captured` receives the
 * assembled system prompt from the stub aiRouter.complete().
 */
function makeDeps(opts: {
  memoryTier?: MemoryTierService;
  contextEngine?: ContextEngine;
  activeProject?: string | null;
  activeProjectId?: string | null;
  lessons?: string;
  preferences?: string;
  userModel?: string;
  captured: { system?: string };
}): ServiceContainer {
  const log = () => {};
  const deps: any = {
    injectionDetector: { detect: () => ({ detected: false, patterns: [], hasHardPattern: false }) },
    permissions: { checkRateLimit: () => true },
    audit: { log },
    activityLog: { log },
    preferences: {
      detectFromMessage: async () => [],
      buildContext: () => opts.preferences ?? '',
    },
    soul: { getFullContext: () => 'SOUL_IDENTITY_TEXT' },
    memory: {
      getRelevant: async () => 'BOOK_BIBLE_MEMORY',
      getActiveProject: async () => opts.activeProject ?? null,
      getActiveProjectId: () => opts.activeProjectId ?? null,
      getActivePersonaId: () => null,
      process: async () => {},
    },
    skills: { matchSkills: () => [] },
    heartbeat: { getContext: () => '', recordActivity: log },
    aiRouter: {
      selectProvider: () => ({ id: 'gemini' }),
      complete: async (req: { system: string }) => {
        opts.captured.system = req.system;
        return { text: 'ok', tokensUsed: 1, estimatedCost: 0, provider: 'gemini' };
      },
      getFallbackProvider: () => null,
    },
    config: { get: (_k: string, d: any) => d },
    costs: { record: log },
    userModel: opts.userModel
      ? { buildContext: () => opts.userModel, observe: log, maybeConsolidate: async () => {} }
      : undefined,
    lessons: opts.lessons ? { buildContext: () => opts.lessons } : undefined,
    authorOS: { getAvailableTools: () => [] },
    research: { getAllowedDomains: () => ['example.com'] },
    memoryTier: opts.memoryTier,
    contextEngine: opts.contextEngine,
  };
  return deps as ServiceContainer;
}

/** Run one chat turn through the pipeline and return the assembled system prompt. */
async function runChat(deps: ServiceContainer, message: string, captured: { system?: string }): Promise<string> {
  const pipeline = new MessagePipeline(deps);
  await pipeline.handleMessage(message, 'api', () => {});
  return captured.system ?? '';
}

// ═══════════════════════════════════════════════════════════
// CHAT CORE injection
// ═══════════════════════════════════════════════════════════

describe('chat CORE injection (Chunk B2)', () => {
  it('injects "# Story Memory (Core)" when a project is active and memoryTier is wired', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, null, workspaceDir),
      contextEngine: engine,
      activeProject: 'ACTIVE_PROJECT_BLURB',
      activeProjectId: 'proj-core',
      captured,
    });
    const system = await runChat(deps, 'What happened with Aria?', captured);
    expect(system).toContain('# Story Memory (Core)');
    expect(system).toContain('# CORE STORY MEMORY');       // the tier block header
    // latestChapterNumber = 2 (highest cached summary); buildCore's P1 slot
    // surfaces the state of the chapter BEFORE the active one — i.e. ch1's
    // ending — as the "most recent completed state".
    expect(system).toContain('Aria sets sail into the storm'); // ch1 ending state
    expect(system).toContain('Aria');                          // promoted character sheet
  });

  it('emits NO CORE block (prior behavior) when memoryTier is unwired', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    const deps = makeDeps({
      // memoryTier omitted
      contextEngine: engine,
      activeProject: 'ACTIVE_PROJECT_BLURB',
      activeProjectId: 'proj-core',
      captured,
    });
    const system = await runChat(deps, 'What happened with Aria?', captured);
    expect(system).not.toContain('# Story Memory (Core)');
    expect(system).not.toContain('# CORE STORY MEMORY');
  });

  it('emits NO CORE block when there is no active project', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, null, workspaceDir),
      contextEngine: engine,
      activeProject: null,        // no active project
      activeProjectId: null,
      captured,
    });
    const system = await runChat(deps, 'What happened with Aria?', captured);
    expect(system).not.toContain('# Story Memory (Core)');
  });
});

// ═══════════════════════════════════════════════════════════
// CHAT ARCHIVAL recall
// ═══════════════════════════════════════════════════════════

describe('chat ARCHIVAL recall (Chunk B2)', () => {
  it('splices "# From Your Manuscript & Past Work" from the FTS archive', async () => {
    const captured: { system?: string } = {};
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, fakeSearch(), workspaceDir),
      contextEngine: engine,
      activeProject: null,
      activeProjectId: null,
      captured,
    });
    const system = await runChat(deps, 'the reckoning', captured);
    expect(system).toContain('# From Your Manuscript & Past Work');
    expect(system).toContain('ARCHIVAL_MANUSCRIPT_HIT');
    // The existing book-bible memory is still present (additive, not replaced).
    expect(system).toContain('BOOK_BIBLE_MEMORY');
  });

  it('emits NO archival block when memorySearch is unavailable (byte-identical path)', async () => {
    const captured: { system?: string } = {};
    const unavailable = {
      isAvailable: () => false,
      search: () => [],
    } as unknown as MemorySearchService;
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, unavailable, workspaceDir),
      contextEngine: engine,
      activeProject: null,
      activeProjectId: null,
      captured,
    });
    const system = await runChat(deps, 'the reckoning', captured);
    expect(system).not.toContain('# From Your Manuscript & Past Work');
    // Book-bible memory still there — chat unchanged otherwise.
    expect(system).toContain('BOOK_BIBLE_MEMORY');
  });
});

// ═══════════════════════════════════════════════════════════
// TOTAL budget guard — trim ordering
// ═══════════════════════════════════════════════════════════

describe('total budget guard trim ordering (Chunk B2)', () => {
  // Sizes chosen so the guard must drop EXACTLY lessons then preferences to get
  // back under the ~24,000 cap, while user-model + archival survive — pinning
  // the trim ORDER deterministically (base prompt ≈ 2k):
  //   full:          2k + 15k + 15k + 8k + arch  ≈ 40k  (> cap)
  //   drop lessons:  2k +       15k + 8k + arch  ≈ 25k  (> cap → keep going)
  //   drop prefs:    2k +             8k + arch  ≈ 10k  (≤ cap → stop)
  const bigLessons = 'LESSONS_SENTINEL ' + 'L'.repeat(15000);
  const bigPrefs = 'PREFS_SENTINEL ' + 'P'.repeat(15000);
  const bigUserModel = '## What I know about you\nUSERMODEL_SENTINEL ' + 'U'.repeat(8000);

  function overBudgetDeps(captured: { system?: string }): ServiceContainer {
    return makeDeps({
      memoryTier: new MemoryTierService(engine, fakeSearch(archivalSentinelHits()), workspaceDir),
      contextEngine: engine,
      activeProject: 'ACTIVE_PROJECT_BLURB',
      activeProjectId: 'proj-core',
      lessons: bigLessons,
      preferences: bigPrefs,
      userModel: bigUserModel,
      captured,
    });
  }
  function archivalSentinelHits(): SearchHit[] {
    return [{
      id: 9, source: 'manuscript', sourceRef: 'x.md', personaId: null, projectId: null,
      timestamp: '2026-01-01T00:00:00Z', title: 'Archival Title',
      snippet: 'ARCHIVAL_SENTINEL excerpt', rank: -1,
    }];
  }

  it('drops lessons FIRST, then preferences, then user-model, then archival — protecting soul/CORE/project/security', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    const system = await runChat(overBudgetDeps(captured), 'reckoning', captured);

    // Under the soft cap after trimming.
    expect(system.length).toBeLessThanOrEqual(24000);

    // Trim order pinned: lessons (lowest priority) dropped first, then
    // preferences — and the guard STOPS as soon as it is under budget, so
    // user-model (next in line) and archival both survive.
    expect(system).not.toContain('LESSONS_SENTINEL');   // dropped 1st
    expect(system).not.toContain('PREFS_SENTINEL');     // dropped 2nd
    expect(system).toContain('USERMODEL_SENTINEL');     // survived (guard stopped)
    expect(system).toContain('ARCHIVAL_SENTINEL');      // survived (lowest, never reached)

    // Protected sections always survive.
    expect(system).toContain('SOUL_IDENTITY_TEXT');       // soul
    expect(system).toContain('# CORE STORY MEMORY');      // CORE block
    expect(system).toContain('ACTIVE_PROJECT_BLURB');     // active project
    expect(system).toContain('# Security Rules');         // security section
  });

  it('drops ONLY lessons (highest-to-trim) when a single drop suffices — prefs/user-model survive', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    // One ~14k block over the cap; base+prefs(6k)+um(4k)+arch ≈ under 24k after
    // dropping lessons alone, so the guard removes lessons FIRST and stops.
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, fakeSearch(archivalSentinelHits()), workspaceDir),
      contextEngine: engine,
      activeProject: 'ACTIVE_PROJECT_BLURB',
      activeProjectId: 'proj-core',
      lessons: 'LESSONS_SENTINEL ' + 'L'.repeat(14000),
      preferences: 'PREFS_SENTINEL ' + 'P'.repeat(6000),
      userModel: '## What I know about you\nUSERMODEL_SENTINEL ' + 'U'.repeat(4000),
      captured,
    });
    const system = await runChat(deps, 'reckoning', captured);
    expect(system.length).toBeLessThanOrEqual(24000);
    expect(system).not.toContain('LESSONS_SENTINEL');  // lessons is trimmed first
    expect(system).toContain('PREFS_SENTINEL');         // and only lessons — prefs stays
    expect(system).toContain('USERMODEL_SENTINEL');
    expect(system).toContain('ARCHIVAL_SENTINEL');
  });

  it('is byte-identical (no trimming) when the prompt is under the cap', async () => {
    await seedSummaries('proj-core');
    const captured: { system?: string } = {};
    const deps = makeDeps({
      memoryTier: new MemoryTierService(engine, fakeSearch(), workspaceDir),
      contextEngine: engine,
      activeProject: 'ACTIVE_PROJECT_BLURB',
      activeProjectId: 'proj-core',
      lessons: 'SMALL_LESSON',
      preferences: 'SMALL_PREF',
      userModel: '## What I know about you\nSMALL_UM',
      captured,
    });
    const system = await runChat(deps, 'reckoning', captured);
    // Nothing trimmed — all low-priority sentinels present.
    expect(system).toContain('SMALL_LESSON');
    expect(system).toContain('SMALL_PREF');
    expect(system).toContain('SMALL_UM');
    expect(system.length).toBeLessThan(24000);
  });
});
