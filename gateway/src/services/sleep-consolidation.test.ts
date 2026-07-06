import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine, type ProjectContext } from './context-engine.js';
import { MemoryTierService } from './memory-tier.js';
import { PreferenceStore } from './preferences.js';
import {
  SleepConsolidationService,
  type SleepProjectPort,
  type SleepAISelectProviderFn,
} from './sleep-consolidation.js';

const PROJECT_ID = 'sleep-test';

// A minimal 2-chapter novel context with two recurring characters, threads,
// and a world rule — enough to exercise every pass.
function seedContext(): ProjectContext {
  return {
    projectId: PROJECT_ID,
    updatedAt: new Date().toISOString(),
    summaries: [
      {
        chapterId: `${PROJECT_ID}-step-1`,
        chapterNumber: 1,
        title: 'Opening',
        summary: 'Aria meets Kael. The storm at sea rages.',
        wordCount: 3000,
        characters: ['Aria', 'Kael'],
        locations: ['Docks'],
        timelineMarker: 'Day 1',
        plotThreads: ['the storm at sea', 'the missing heir'],
        endingState: 'Aria sets out to find the heir.',
      },
      {
        chapterId: `${PROJECT_ID}-step-2`,
        chapterNumber: 2,
        title: 'The Vault',
        summary: 'Aria and Kael open the vault. The storm passes.',
        wordCount: 3200,
        characters: ['Aria', 'Kael'],
        locations: ['Vault'],
        timelineMarker: 'Day 3',
        plotThreads: ['the missing heir', 'the sealed vault'],
        endingState: 'The storm at sea has finally cleared.',
      },
    ],
    entities: [
      {
        name: 'Aria', type: 'character', aliases: [],
        description: 'A dockside courier.', firstAppearance: 'ch1', lastSeen: 'ch2',
        attributes: { role: 'protagonist' }, changes: [{ chapterId: 'ch2', description: 'learned to pick locks' }],
      },
      {
        name: 'Kael', type: 'character', aliases: [],
        description: 'A watchful stranger.', firstAppearance: 'ch1', lastSeen: 'ch2',
        attributes: { role: 'wildcard' }, changes: [],
      },
      {
        name: 'The Balance', type: 'rule', aliases: [],
        description: 'Magic must be repaid in equal measure.', firstAppearance: 'ch2', lastSeen: 'ch2',
        attributes: {}, changes: [],
      },
    ],
  };
}

let workspaceDir: string;
let contextEngine: ContextEngine;
let memoryTier: MemoryTierService;
let preferences: PreferenceStore;

/** Fake project port exposing our single seeded project. */
function fakeProjects(): SleepProjectPort {
  const project = {
    id: PROJECT_ID,
    title: 'Sleep Test',
    type: 'novel-pipeline',
    status: 'completed',
    personaId: 'persona-1',
    steps: [
      { id: `${PROJECT_ID}-step-1`, label: 'Write Chapter 1', chapterNumber: 1, status: 'completed', phase: 'writing', result: 'A'.repeat(400) },
      { id: `${PROJECT_ID}-step-2`, label: 'Write Chapter 2', chapterNumber: 2, status: 'completed', phase: 'writing', result: 'B'.repeat(400) },
    ],
  };
  return {
    listProjects: () => [project],
    getProject: (id) => (id === PROJECT_ID ? project : undefined),
  };
}

async function loadSeed(ctx: ProjectContext): Promise<void> {
  const contextDir = join(workspaceDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, `${ctx.projectId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
  await contextEngine.loadContext(ctx.projectId);
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'authorclaw-sleep-'));
  contextEngine = new ContextEngine(workspaceDir);
  memoryTier = new MemoryTierService(contextEngine, null, workspaceDir);
  preferences = new PreferenceStore(join(workspaceDir, 'memory'));
  await preferences.initialize();

  // Provide a soul/STYLE-GUIDE so the style pass has a source.
  const soulDir = join(workspaceDir, 'soul');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'STYLE-GUIDE.md'), 'Write in third-person past tense. Short punchy sentences. No adverbs.', 'utf-8');
});

afterEach(() => {
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SleepConsolidationService.run', () => {
  it('runs all passes with free-tier AI only and materializes the core digest', async () => {
    await loadSeed(seedContext());

    // Record every provider tier the job resolves during the run.
    const tiersObserved: string[] = [];
    const aiSelectProvider: SleepAISelectProviderFn = (taskType) => {
      // Only the three free task types should ever be requested.
      expect(['general', 'research', 'marketing']).toContain(taskType);
      const provider = { id: 'gemini', tier: 'free' as const };
      tiersObserved.push(provider.tier);
      return provider;
    };

    // Stub aiComplete: entity extraction expects JSON; thread classification
    // expects {threads:[...]}; arc/style expect plain prose.
    const aiComplete = vi.fn(async (req: any) => {
      const sys = req.system || '';
      let text: string;
      if (sys.includes('Extract named entities')) {
        text = JSON.stringify({ entities: [{ name: 'Aria', type: 'character', aliases: [], description: 'A courier.', attributes: {} }] });
      } else if (sys.includes('classify each thread')) {
        text = JSON.stringify({ threads: [
          { thread: 'the storm at sea', status: 'resolved' },
          { thread: 'the missing heir', status: 'open' },
          { thread: 'the sealed vault', status: 'open' },
        ] });
      } else if (sys.includes('character')) {
        text = 'Aria grows from a cautious courier into a decisive leader.';
      } else {
        text = 'Third-person past tense; terse, sensory prose; avoid adverbs.';
      }
      return { text, tokensUsed: 10, estimatedCost: 0, provider: req.provider };
    });

    const writeSpy = vi.spyOn(memoryTier, 'writeCoreDigest');

    const svc = new SleepConsolidationService({
      contextEngine,
      seriesBible: null,        // no series → pass 5 degrades gracefully
      preferences,
      memorySearch: null,       // no FTS → pass 7 degrades gracefully
      memoryTier,
      projects: fakeProjects(),
      aiComplete,
      aiSelectProvider,
      workspaceDir,
    });

    const result = await svc.run({ projectId: PROJECT_ID });

    // Run succeeds and reports the single project.
    expect(result.success).toBe(true);
    expect(result.details.projects).toHaveLength(1);

    // COST RULE: every observed provider tier is free.
    expect(tiersObserved.length).toBeGreaterThan(0);
    expect(tiersObserved.every(t => t === 'free')).toBe(true);

    // writeCoreDigest was called and the file exists on disk.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const corePath = join(workspaceDir, 'context', `${PROJECT_ID}-core.json`);
    expect(existsSync(corePath)).toBe(true);

    const digest = JSON.parse(readFileSync(corePath, 'utf-8'));
    // styleDigest present, threads classified (storm resolved), arcs present.
    expect(typeof digest.styleDigest).toBe('string');
    expect(digest.styleDigest.length).toBeGreaterThan(0);
    expect(digest.resolvedThreads).toContain('the storm at sea');
    expect(digest.openThreads).toContain('the missing heir');
    expect(Object.keys(digest.arcs || {}).length).toBeGreaterThan(0);
    expect(digest.promotedBaseline).toContain('Aria');

    // AI-call budget respected (well under the cap).
    expect(result.details.projects[0].aiCalls).toBeLessThanOrEqual(10);
  });

  it('never spends an AI call on a non-free-tier provider (fails that pass closed)', async () => {
    await loadSeed(seedContext());

    // A misconfigured selector that returns a PAID provider. The cost-rule guard
    // must refuse to complete, so aiComplete is never invoked.
    const aiComplete = vi.fn(async (req: any) => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: req.provider }));
    const aiSelectProvider: SleepAISelectProviderFn = () => ({ id: 'claude', tier: 'paid' });

    const svc = new SleepConsolidationService({
      contextEngine, seriesBible: null, preferences, memorySearch: null, memoryTier,
      projects: fakeProjects(), aiComplete, aiSelectProvider, workspaceDir,
    });

    const result = await svc.run({ projectId: PROJECT_ID });
    // The run still succeeds (each pass guarded) and still writes a digest, but
    // no paid completion was ever spent.
    expect(result.success).toBe(true);
    expect(aiComplete).not.toHaveBeenCalled();
    // The style pass falls back to the STYLE-GUIDE first 600 chars (no AI).
    const digest = JSON.parse(readFileSync(join(workspaceDir, 'context', `${PROJECT_ID}-core.json`), 'utf-8'));
    expect(digest.styleDigest).toContain('third-person');
  });
});
