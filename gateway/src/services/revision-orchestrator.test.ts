import { describe, it, expect, vi } from 'vitest';
import { RevisionOrchestrator } from './revision-orchestrator.js';
import type { RevisionOrchestratorDeps } from './revision-orchestrator.js';

// ═══════════════════════════════════════════════════════════
// Test doubles — minimal stubs matching the analyzer surfaces the
// orchestrator actually calls. Typed loosely (cast to the dep types) so we
// only implement the methods each pass touches.
// ═══════════════════════════════════════════════════════════

function makeContextEngine(opts: {
  issues?: any[];
  characters?: Array<{ name: string; aliases?: string[] }>;
  throws?: boolean;
} = {}) {
  const characters = (opts.characters ?? []).map(c => ({
    name: c.name,
    type: 'character',
    aliases: c.aliases ?? [],
    description: '',
    firstAppearance: '',
    lastSeen: '',
    attributes: {},
    changes: [],
  }));
  return {
    runContinuityCheck: vi.fn(async () => {
      if (opts.throws) throw new Error('continuity boom');
      return {
        projectId: 'p1',
        generatedAt: new Date().toISOString(),
        totalIssues: (opts.issues ?? []).length,
        issuesByCategory: {},
        issues: opts.issues ?? [],
      };
    }),
    getEntitiesByType: vi.fn((_pid: string, _type: string) => characters),
    // The upgraded continuity pass reads these when a detector is present.
    getEntities: vi.fn((_pid: string) => characters),
    getSummaries: vi.fn((_pid: string) => []),
  } as any;
}

/** A stub ContradictionDetector — returns crafted contradictions. */
function makeContradictionDetector(opts: { contradictions?: any[]; throws?: boolean } = {}) {
  return {
    detect: vi.fn(async () => {
      if (opts.throws) throw new Error('detector boom');
      const contradictions = opts.contradictions ?? [];
      return {
        projectId: 'p1',
        generatedAt: new Date().toISOString(),
        total: contradictions.length,
        byCategory: {},
        bySeverity: { error: 0, warning: 0, info: 0 },
        contradictions,
      };
    }),
  } as any;
}

function makeCharacterVoices(opts: { flags?: any[]; throws?: boolean } = {}) {
  return {
    detectDrift: vi.fn(async () => {
      if (opts.throws) throw new Error('drift boom');
      return {
        projectId: 'p1',
        chapterNumber: 0,
        characters: [
          {
            name: 'Alice',
            linesInChapter: 5,
            wordsInChapter: 80,
            driftScore: 40,
            flags: opts.flags ?? [],
          },
        ],
        overallDriftScore: 40,
        summary: '',
      };
    }),
  } as any;
}

function makeCraftCritic(opts: { flags?: any[]; throws?: boolean } = {}) {
  return {
    analyze: vi.fn(() => {
      if (opts.throws) throw new Error('craft boom');
      return {
        generatedAt: new Date().toISOString(),
        projectId: 'revision-pass',
        overall: {} as any,
        chapters: [],
        flags: opts.flags ?? [],
        beats: [],
        saveTheCatAdherence: 0,
      };
    }),
  } as any;
}

function makeDialogueAuditor(opts: { flags?: any[] } = {}) {
  return {
    audit: vi.fn(() => ({
      totalLines: 0,
      attributed: 0,
      unattributed: 0,
      fingerprints: [],
      flags: opts.flags ?? [],
    })),
  } as any;
}

function makeWritingJudge(opts: { issues?: any[]; spy?: () => void } = {}) {
  return {
    mechanicalScreen: vi.fn((_text: string) => {
      opts.spy?.();
      return {
        wordCount: 100,
        issues: opts.issues ?? [],
        score: 90,
      };
    }),
  } as any;
}

/** A recording aiSelectProvider — captures the task types each pass requests. */
function makeAiSelect() {
  const calls: string[] = [];
  const fn = vi.fn((taskType: string) => {
    calls.push(taskType);
    return { id: 'stub-provider' };
  });
  return { fn, calls };
}

const CHAPTER = 'She was very unique. "I am here," said Alice. She started to walk.';

describe('RevisionOrchestrator.analyze — pass orchestration + aggregation', () => {
  it('runs the applicable passes and aggregates their findings into one report', async () => {
    const deps: RevisionOrchestratorDeps = {
      contextEngine: makeContextEngine({
        issues: [
          { category: 'character', severity: 'error', description: 'Eye color changed', chapters: ['c1', 'c2'], evidence: [], suggestion: 'Pick one' },
        ],
        characters: [{ name: 'Alice' }],
      }),
      characterVoices: makeCharacterVoices({
        flags: [{ characterName: 'Alice', chapterNumber: 0, excerpt: '"hi"', marker: 'contraction use', expected: 5, actual: 20, zScore: 3, note: 'drifted' }],
      }),
      craftCritic: makeCraftCritic({
        flags: [{ chapterId: 'c', chapterNumber: 1, title: 'C', category: 'telling', severity: 'warning', description: 'too much telling', suggestion: 'show it' }],
      }),
      dialogueAuditor: makeDialogueAuditor(),
      writingJudge: makeWritingJudge({
        issues: [{ category: 'ai_tell', severity: 'warning', description: 'AI-tell phrase', examples: ['delve into'], count: 1 }],
      }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, chapterId: 'ch-1' });

    expect(report.passesRun.sort()).toEqual(['anti-slop', 'continuity', 'craft', 'voice']);
    // fact is a documented stub → always skipped
    expect(report.passesSkipped).toContain('fact');
    expect(report.projectId).toBe('p1');
    expect(report.chapterId).toBe('ch-1');
    // One finding per pass (continuity, voice, craft, anti-slop).
    expect(report.totalFindings).toBe(4);
    expect(report.findingsByPass).toMatchObject({ continuity: 1, voice: 1, craft: 1, 'anti-slop': 1 });
    expect(report.findingsBySeverity.error).toBe(1);
    expect(report.findingsBySeverity.warning).toBe(3);
  });

  it('isolates a throwing pass — the others still run and it is listed in passesSkipped', async () => {
    const deps: RevisionOrchestratorDeps = {
      contextEngine: makeContextEngine({ throws: true, characters: [{ name: 'Alice' }] }),
      characterVoices: makeCharacterVoices({ flags: [] }),
      craftCritic: makeCraftCritic({
        flags: [{ chapterId: 'c', chapterNumber: 1, title: 'C', category: 'adverbs', severity: 'info', description: 'adverbs', suggestion: 'cut' }],
      }),
      dialogueAuditor: makeDialogueAuditor(),
      writingJudge: makeWritingJudge({
        issues: [{ category: 'suddenly', severity: 'info', description: 'suddenly x2', examples: [], count: 2 }],
      }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER });

    // continuity threw → skipped; craft + anti-slop still ran.
    expect(report.passesSkipped).toContain('continuity');
    expect(report.passesRun).toContain('craft');
    expect(report.passesRun).toContain('anti-slop');
    expect(report.totalFindings).toBe(2);
  });

  it('sorts findings by severity: error > warning > info', async () => {
    const deps: RevisionOrchestratorDeps = {
      writingJudge: makeWritingJudge({
        issues: [
          { category: 'suddenly', severity: 'info', description: 'info issue', examples: [], count: 2 },
          { category: 'ai_tell', severity: 'error', description: 'error issue', examples: [], count: 5 },
          { category: 'filter_word', severity: 'warning', description: 'warning issue', examples: [], count: 3 },
        ],
      }),
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ chapterText: CHAPTER, passes: ['anti-slop'] });

    expect(report.findings.map(f => f.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('dedupes findings with the same category + location + similar description', async () => {
    const deps: RevisionOrchestratorDeps = {
      writingJudge: makeWritingJudge({
        issues: [
          // Same category, same (undefined) location, description differs only
          // by the leading count → normalized to the same key → deduped.
          { category: 'adverb_density', severity: 'warning', description: '3 -ly adverbs per 1000 words.', examples: [], count: 3 },
          { category: 'adverb_density', severity: 'warning', description: '7 -ly adverbs per 1000 words.', examples: [], count: 7 },
          // Distinct category → kept.
          { category: 'passive_voice', severity: 'warning', description: 'passive voice', examples: [], count: 2 },
        ],
      }),
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ chapterText: CHAPTER, chapterId: 'c', passes: ['anti-slop'] });

    // The two adverb_density findings collapse to one; passive_voice stays.
    expect(report.totalFindings).toBe(2);
    const categories = report.findings.map(f => f.category).sort();
    expect(categories).toEqual(['adverb_density', 'passive_voice']);
  });

  it('anti-slop pass runs with NO AI call — mechanical only', async () => {
    let screenCalled = false;
    const aiComplete = vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' }));
    const { fn: aiSelectProvider, calls } = makeAiSelect();
    const deps: RevisionOrchestratorDeps = {
      writingJudge: makeWritingJudge({ issues: [], spy: () => { screenCalled = true; } }),
      aiComplete,
      aiSelectProvider,
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ chapterText: CHAPTER, passes: ['anti-slop'] });

    expect(report.passesRun).toEqual(['anti-slop']);
    expect(screenCalled).toBe(true);
    // The mechanical pass must never touch the AI closures.
    expect(aiComplete).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('honors the passes filter — passes:["anti-slop"] runs only that pass', async () => {
    const contextEngine = makeContextEngine({ characters: [{ name: 'Alice' }], issues: [] });
    const characterVoices = makeCharacterVoices({ flags: [] });
    const craftCritic = makeCraftCritic({ flags: [] });
    const deps: RevisionOrchestratorDeps = {
      contextEngine,
      characterVoices,
      craftCritic,
      dialogueAuditor: makeDialogueAuditor(),
      writingJudge: makeWritingJudge({ issues: [] }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    };
    const orch = new RevisionOrchestrator(deps);

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, passes: ['anti-slop'] });

    expect(report.passesRun).toEqual(['anti-slop']);
    // Other analyzers must not have been invoked at all.
    expect(contextEngine.runContinuityCheck).not.toHaveBeenCalled();
    expect(characterVoices.detectDrift).not.toHaveBeenCalled();
    expect(craftCritic.analyze).not.toHaveBeenCalled();
  });
});

describe('RevisionOrchestrator — per-pass tier routing (aiSelectProvider spy)', () => {
  it('continuity requests the "consistency" tier', async () => {
    const { fn: aiSelectProvider, calls } = makeAiSelect();
    const orch = new RevisionOrchestrator({
      contextEngine: makeContextEngine({ issues: [], characters: [{ name: 'Alice' }] }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider,
    });
    await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, passes: ['continuity'] });
    expect(calls).toContain('consistency');
  });

  it('voice requests the "style_analysis" tier', async () => {
    const { fn: aiSelectProvider, calls } = makeAiSelect();
    const orch = new RevisionOrchestrator({
      contextEngine: makeContextEngine({ characters: [{ name: 'Alice' }] }),
      characterVoices: makeCharacterVoices({ flags: [] }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider,
    });
    await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, passes: ['voice'] });
    expect(calls).toContain('style_analysis');
  });

  it('craft requests the "revision" tier', async () => {
    const { fn: aiSelectProvider, calls } = makeAiSelect();
    const orch = new RevisionOrchestrator({
      craftCritic: makeCraftCritic({ flags: [] }),
      dialogueAuditor: makeDialogueAuditor(),
      aiSelectProvider,
    });
    await orch.analyze({ chapterText: CHAPTER, passes: ['craft'] });
    expect(calls).toContain('revision');
  });
});

describe('RevisionOrchestrator — continuity pass uses ContradictionDetector (guarded)', () => {
  it('prefers the detector: maps Contradictions → Findings (category = CATEGORY/subtype, evidence in description)', async () => {
    const contextEngine = makeContextEngine({ characters: [{ name: 'Kai' }] });
    const detector = makeContradictionDetector({
      contradictions: [
        {
          category: 'CHARACTER',
          subtype: 'trait',
          severity: 'error',
          description: "Kai's eyes changed color.",
          chapterEvidence: 'brown eyes',
          priorEvidence: 'eyeColor=green',
          entity: 'Kai',
          suggestion: 'pick one',
        },
      ],
    });
    const orch = new RevisionOrchestrator({
      contextEngine,
      contradictionDetector: detector,
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    });

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, chapterId: 'c2', passes: ['continuity'] });

    expect(detector.detect).toHaveBeenCalledOnce();
    // Fallback whole-index check must NOT run when the detector is present.
    expect(contextEngine.runContinuityCheck).not.toHaveBeenCalled();
    expect(report.totalFindings).toBe(1);
    const f = report.findings[0];
    expect(f.pass).toBe('continuity');
    expect(f.category).toBe('CHARACTER/trait');
    expect(f.severity).toBe('error');
    expect(f.location).toBe('Kai');
    // Evidence chain is folded into the description.
    expect(f.description).toContain('brown eyes');
    expect(f.description).toContain('eyeColor=green');
  });

  it('falls back to runContinuityCheck when NO detector is wired', async () => {
    const contextEngine = makeContextEngine({
      characters: [{ name: 'Kai' }],
      issues: [
        { category: 'character', severity: 'warning', description: 'old-style issue', chapters: ['c1'], evidence: [], suggestion: 'fix' },
      ],
    });
    const orch = new RevisionOrchestrator({
      contextEngine, // no contradictionDetector
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    });

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, passes: ['continuity'] });

    expect(contextEngine.runContinuityCheck).toHaveBeenCalledOnce();
    expect(report.totalFindings).toBe(1);
    expect(report.findings[0].category).toBe('character');
  });

  it('a throwing detector is isolated — continuity is skipped, not fatal', async () => {
    const contextEngine = makeContextEngine({ characters: [{ name: 'Kai' }] });
    const detector = makeContradictionDetector({ throws: true });
    const orch = new RevisionOrchestrator({
      contextEngine,
      contradictionDetector: detector,
      writingJudge: makeWritingJudge({ issues: [] }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    });

    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER, passes: ['continuity', 'anti-slop'] });

    expect(report.passesSkipped).toContain('continuity');
    expect(report.passesRun).toContain('anti-slop');
  });
});

describe('RevisionOrchestrator — graceful skips', () => {
  it('skips continuity + voice when projectId is absent, still runs mechanical passes', async () => {
    const orch = new RevisionOrchestrator({
      contextEngine: makeContextEngine({ characters: [{ name: 'Alice' }] }),
      characterVoices: makeCharacterVoices({ flags: [] }),
      craftCritic: makeCraftCritic({ flags: [] }),
      dialogueAuditor: makeDialogueAuditor(),
      writingJudge: makeWritingJudge({ issues: [] }),
      aiComplete: vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'stub' })),
      aiSelectProvider: vi.fn((_t: string) => ({ id: 'stub' })),
    });
    const report = await orch.analyze({ chapterText: CHAPTER });
    expect(report.passesSkipped).toContain('continuity');
    expect(report.passesSkipped).toContain('voice');
    expect(report.passesRun).toContain('craft');
    expect(report.passesRun).toContain('anti-slop');
  });

  it('skips a pass whose analyzer is missing (null dep)', async () => {
    const orch = new RevisionOrchestrator({
      // No analyzers at all.
    });
    const report = await orch.analyze({ projectId: 'p1', chapterText: CHAPTER });
    expect(report.passesRun).toEqual([]);
    expect(report.passesSkipped.sort()).toEqual(['anti-slop', 'continuity', 'craft', 'fact', 'voice']);
    expect(report.totalFindings).toBe(0);
  });
});
