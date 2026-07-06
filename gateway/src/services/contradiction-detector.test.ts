import { describe, it, expect, vi } from 'vitest';
import {
  ContradictionDetector,
  CONTRADICTION_TAXONOMY,
} from './contradiction-detector.js';
import type { EntityEntry, ChapterSummary } from './context-engine.js';

// ═══════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════

function makeEntities(): EntityEntry[] {
  return [
    {
      name: 'Kai',
      type: 'character',
      aliases: [],
      description: 'The protagonist author.',
      firstAppearance: 'c1',
      lastSeen: 'c2',
      attributes: { eyeColor: 'green', role: 'author' },
      changes: [],
    },
    {
      name: 'The Grid',
      type: 'location',
      aliases: ['neural map'],
      description: 'A dying system of servers.',
      firstAppearance: 'c1',
      lastSeen: 'c2',
      attributes: {},
      changes: [],
    },
  ];
}

function makeSummaries(): ChapterSummary[] {
  return [
    {
      chapterId: 'c1',
      chapterNumber: 1,
      title: 'System Failure',
      summary: 'Kai discovers the Grid is failing.',
      wordCount: 1200,
      characters: ['Kai'],
      locations: ['The Grid'],
      timelineMarker: 'Day 1, night',
      plotThreads: ['the failing grid'],
      endingState: 'Kai vows to fix the servers.',
    },
  ];
}

/**
 * A stubbed aiComplete that returns a fixed body, and records the request so
 * tests can assert on the provider/task routing.
 */
function makeAiComplete(body: string) {
  return vi.fn(async (_req: any) => ({
    text: body,
    tokensUsed: 100,
    estimatedCost: 0,
    provider: 'stub',
  }));
}

/** A recording aiSelectProvider — captures the task types requested. */
function makeAiSelect() {
  const calls: string[] = [];
  const fn = vi.fn((taskType: string) => {
    calls.push(taskType);
    return { id: 'stub-provider' };
  });
  return { fn, calls };
}

const CRAFTED_JSON = JSON.stringify({
  contradictions: [
    {
      category: 'CHARACTER',
      subtype: 'trait',
      severity: 'error',
      description: "Kai's eye color changed.",
      chapterEvidence: 'His brown eyes narrowed.',
      priorEvidence: 'eyeColor=green',
      entity: 'Kai',
      suggestion: 'Pick one eye color and use it consistently.',
    },
    {
      category: 'TIMELINE',
      subtype: 'chronology',
      severity: 'warning',
      description: 'Events happen before the prior chapter.',
      chapterEvidence: 'The day before the grid failed...',
      priorEvidence: 'Day 1, night — grid already failing',
      suggestion: 'Reconcile the ordering.',
    },
  ],
});

// ═══════════════════════════════════════════════════════════
// Taxonomy shape
// ═══════════════════════════════════════════════════════════

describe('CONTRADICTION_TAXONOMY', () => {
  it('has exactly the 5 ConStory categories', () => {
    expect(Object.keys(CONTRADICTION_TAXONOMY).sort()).toEqual(
      ['CHARACTER', 'FACTUAL', 'STYLE', 'TIMELINE', 'WORLD_RULE'],
    );
  });

  it('each category carries a label and a non-empty subtypes list', () => {
    for (const [key, def] of Object.entries(CONTRADICTION_TAXONOMY)) {
      expect(typeof def.label, `${key}.label`).toBe('string');
      expect(Array.isArray(def.subtypes), `${key}.subtypes`).toBe(true);
      expect(def.subtypes.length, `${key}.subtypes length`).toBeGreaterThan(0);
    }
  });

  it('defines the expected subtypes per category', () => {
    expect(CONTRADICTION_TAXONOMY.CHARACTER.subtypes).toEqual([
      'trait', 'knowledge', 'relationship', 'ability', 'state',
    ]);
    expect(CONTRADICTION_TAXONOMY.TIMELINE.subtypes).toEqual(['chronology', 'duration', 'sequence']);
    expect(CONTRADICTION_TAXONOMY.WORLD_RULE.subtypes).toEqual(['magic-system', 'setting', 'physics']);
    expect(CONTRADICTION_TAXONOMY.FACTUAL.subtypes).toEqual(['name', 'number', 'object', 'location']);
    expect(CONTRADICTION_TAXONOMY.STYLE.subtypes).toEqual(['POV-break', 'tense-shift']);
  });
});

// ═══════════════════════════════════════════════════════════
// detect() — parsing, aggregation, evidence
// ═══════════════════════════════════════════════════════════

describe('ContradictionDetector.detect — parsing + aggregation', () => {
  it('parses crafted JSON into typed Contradictions with populated evidence fields', async () => {
    const detector = new ContradictionDetector();
    const aiComplete = makeAiComplete(CRAFTED_JSON);
    const { fn: aiSelect } = makeAiSelect();

    const report = await detector.detect(
      {
        projectId: 'project-13',
        chapterText: 'His brown eyes narrowed. The day before the grid failed...',
        chapterId: 'c2',
        priorSummaries: makeSummaries(),
        entities: makeEntities(),
      },
      aiComplete,
      aiSelect,
    );

    expect(report.projectId).toBe('project-13');
    expect(report.chapterId).toBe('c2');
    expect(report.total).toBe(2);
    expect(report.contradictions).toHaveLength(2);

    const [first] = report.contradictions;
    expect(first.category).toBe('CHARACTER');
    expect(first.subtype).toBe('trait');
    expect(first.severity).toBe('error');
    expect(first.entity).toBe('Kai');
    // Evidence is chained — BOTH sides are present.
    expect(first.chapterEvidence).toBe('His brown eyes narrowed.');
    expect(first.priorEvidence).toBe('eyeColor=green');
    expect(first.suggestion).toBeTruthy();
  });

  it('aggregates byCategory and bySeverity', async () => {
    const detector = new ContradictionDetector();
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x', entities: makeEntities() },
      makeAiComplete(CRAFTED_JSON),
      makeAiSelect().fn,
    );

    expect(report.byCategory).toEqual({ CHARACTER: 1, TIMELINE: 1 });
    expect(report.bySeverity).toEqual({ error: 1, warning: 1, info: 0 });
  });

  it('requests the "consistency" task type (mid tier)', async () => {
    const detector = new ContradictionDetector();
    const { fn: aiSelect, calls } = makeAiSelect();

    await detector.detect(
      { projectId: 'p', chapterText: 'x', entities: makeEntities() },
      makeAiComplete(CRAFTED_JSON),
      aiSelect,
    );

    expect(calls).toContain('consistency');
    // It must NOT reach for a premium tier.
    expect(calls).not.toContain('final_edit');
  });

  it('feeds the entity DB (attributes + change-log) and prior summaries into the prompt', async () => {
    const detector = new ContradictionDetector();
    const aiComplete = makeAiComplete('{"contradictions":[]}');
    const entities = makeEntities();
    entities[0].changes.push({ chapterId: 'c2', description: 'role changed from author to editor' });

    await detector.detect(
      { projectId: 'p', chapterText: 'the chapter body', priorSummaries: makeSummaries(), entities },
      aiComplete,
      makeAiSelect().fn,
    );

    const userContent = aiComplete.mock.calls[0][0].messages[0].content as string;
    // Entity attributes present.
    expect(userContent).toContain('Kai');
    expect(userContent).toContain('eyeColor=green');
    // Change-log present.
    expect(userContent).toContain('role changed from author to editor');
    // Prior summary present.
    expect(userContent).toContain('System Failure');
    // Chapter under review present.
    expect(userContent).toContain('the chapter body');
  });
});

// ═══════════════════════════════════════════════════════════
// Robustness — empty / malformed / partial AI output (never throw)
// ═══════════════════════════════════════════════════════════

describe('ContradictionDetector.detect — graceful degradation', () => {
  it('returns an empty report (no throw) on empty AI output', async () => {
    const detector = new ContradictionDetector();
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x' },
      makeAiComplete(''),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(0);
    expect(report.contradictions).toEqual([]);
    expect(report.byCategory).toEqual({});
  });

  it('returns an empty report (no throw) on non-JSON garbage', async () => {
    const detector = new ContradictionDetector();
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x' },
      makeAiComplete('I could not find any contradictions, sorry!'),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(0);
    expect(report.contradictions).toEqual([]);
  });

  it('strips markdown code fences before parsing', async () => {
    const detector = new ContradictionDetector();
    const fenced = '```json\n' + CRAFTED_JSON + '\n```';
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x', entities: makeEntities() },
      makeAiComplete(fenced),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(2);
  });

  it('recovers a truncated array — keeps the complete leading element', async () => {
    const detector = new ContradictionDetector();
    // Second element cut off mid-object (max_tokens simulation).
    const truncated =
      '{"contradictions":[' +
      '{"category":"CHARACTER","subtype":"trait","severity":"error","description":"eye color","chapterEvidence":"brown","priorEvidence":"green","entity":"Kai","suggestion":"fix"},' +
      '{"category":"TIMELINE","subtype":"chron';
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x' },
      makeAiComplete(truncated),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(1);
    expect(report.contradictions[0].category).toBe('CHARACTER');
  });

  it('snaps an invalid category to FACTUAL and an invalid subtype to the category default', async () => {
    const detector = new ContradictionDetector();
    const weird = JSON.stringify({
      contradictions: [
        {
          category: 'NONSENSE',
          subtype: 'also-nonsense',
          severity: 'catastrophic',
          description: 'something is off',
          chapterEvidence: 'the text',
          priorEvidence: 'the fact',
          suggestion: 'fix it',
        },
      ],
    });
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x' },
      makeAiComplete(weird),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(1);
    const c = report.contradictions[0];
    expect(c.category).toBe('FACTUAL');
    // FACTUAL's first subtype is 'name'.
    expect(c.subtype).toBe('name');
    // Invalid severity falls back to 'warning'.
    expect(c.severity).toBe('warning');
  });

  it('drops findings with NO evidence on either side (not evidence-chained)', async () => {
    const detector = new ContradictionDetector();
    const noEvidence = JSON.stringify({
      contradictions: [
        { category: 'CHARACTER', subtype: 'trait', severity: 'warning', description: '', chapterEvidence: '', priorEvidence: '' },
        { category: 'FACTUAL', subtype: 'name', severity: 'info', description: 'name spelling drift', chapterEvidence: 'Jon', priorEvidence: 'John' },
      ],
    });
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'x' },
      makeAiComplete(noEvidence),
      makeAiSelect().fn,
    );
    // First is dropped (no description + no evidence), second kept.
    expect(report.total).toBe(1);
    expect(report.contradictions[0].category).toBe('FACTUAL');
  });

  it('runs with an empty entity DB and empty summaries without throwing', async () => {
    const detector = new ContradictionDetector();
    const report = await detector.detect(
      { projectId: 'p', chapterText: 'A short chapter.' },
      makeAiComplete('{"contradictions":[]}'),
      makeAiSelect().fn,
    );
    expect(report.total).toBe(0);
  });

  it('propagates a provider transport error (so the caller can record a skipped pass)', async () => {
    const detector = new ContradictionDetector();
    const boom = vi.fn(async () => {
      throw new Error('provider 500');
    });
    await expect(
      detector.detect({ projectId: 'p', chapterText: 'x' }, boom, makeAiSelect().fn),
    ).rejects.toThrow('provider 500');
  });
});

// ═══════════════════════════════════════════════════════════
// Entropy pre-filter — documented stub (inert without logprobs)
// ═══════════════════════════════════════════════════════════

describe('ContradictionDetector.entropyPreFilter — deferred stub', () => {
  it('returns ALL paragraph indices when no logprobs are supplied (inert)', () => {
    const detector = new ContradictionDetector();
    const paragraphs = [
      { index: 0, text: 'para one', offset: 0 },
      { index: 1, text: 'para two', offset: 9 },
      { index: 2, text: 'para three', offset: 18 },
    ];
    expect(detector.entropyPreFilter(paragraphs)).toEqual([0, 1, 2]);
  });

  it('would rank by mean surprisal once logprobs exist (interface is real)', () => {
    const detector = new ContradictionDetector();
    const paragraphs = [
      { index: 0, text: 'aa', offset: 0 },
      { index: 1, text: 'bb', offset: 2 },
    ];
    // Paragraph 1's token is far more surprising (logprob -5 vs -0.1).
    const logprobs = [
      { token: 'aa', logprob: -0.1, offset: 0 },
      { token: 'bb', logprob: -5, offset: 2 },
    ];
    const kept = detector.entropyPreFilter(paragraphs, logprobs, { topFraction: 0.5 });
    expect(kept).toEqual([1]);
  });
});
