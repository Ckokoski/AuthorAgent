import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LearningService } from './learning.js';
import type { LearnReportInput } from './learning.js';
import { LessonStore } from './lessons.js';

// ═══════════════════════════════════════════════════════════
// Fixtures — crafted reports with RECURRING findings across the
// three report shapes the learner consumes.
// ═══════════════════════════════════════════════════════════

/** A RevisionReport whose findings repeat the same (pass, category) N times. */
function revisionReport(opts: {
  pass?: string;
  category?: string;
  severity?: 'error' | 'warning' | 'info';
  count?: number;
} = {}): LearnReportInput {
  const pass = opts.pass ?? 'anti-slop';
  const category = opts.category ?? 'adverbs';
  const severity = opts.severity ?? 'warning';
  const count = opts.count ?? 3;
  const findings = Array.from({ length: count }, (_, i) => ({
    pass,
    category,
    severity,
    location: `p${i}`,
    description: `overused ${category} instance ${i}`,
    suggestion: 'use a stronger verb',
  }));
  return {
    type: 'revision',
    report: {
      generatedAt: new Date().toISOString(),
      totalFindings: findings.length,
      findingsBySeverity: { error: 0, warning: findings.length, info: 0 },
      findingsByPass: { [pass]: findings.length },
      findings,
      passesRun: [pass],
      passesSkipped: [],
    },
  };
}

/** A ContradictionReport with repeated TIMELINE contradictions. */
function contradictionReport(count = 3): LearnReportInput {
  const contradictions = Array.from({ length: count }, (_, i) => ({
    category: 'TIMELINE',
    subtype: 'chronology',
    severity: 'error',
    description: `event out of order ${i}`,
    chapterEvidence: `this: ${i}`,
    priorEvidence: `established: ${i}`,
    entity: 'Alice',
    suggestion: 'reorder',
  }));
  return {
    type: 'contradiction',
    report: {
      projectId: 'p1',
      generatedAt: new Date().toISOString(),
      total: contradictions.length,
      byCategory: { TIMELINE: contradictions.length },
      bySeverity: { error: contradictions.length, warning: 0, info: 0 },
      contradictions,
    },
  };
}

/** A CharacterCritiqueReport where one character is repeatedly off-voice. */
function characterReport(character = 'Alice', issue = 'off-voice', count = 3): LearnReportInput {
  const flags = Array.from({ length: count }, (_, i) => ({
    line: `line ${i}`,
    issue,
    reason: `${character} sounds wrong here ${i}`,
    suggestion: 'rewrite',
  }));
  return {
    type: 'character',
    report: {
      projectId: 'p1',
      generatedAt: new Date().toISOString(),
      charactersReviewed: [character],
      totalFlags: flags.length,
      byCharacter: [{ character, linesReviewed: count, flags }],
    },
  };
}

// ── A fake free-tier aiComplete + selectProvider. ──
function fakeAI(lessonsByKey: Record<string, string>) {
  const selectProvider = vi.fn((_t: string) => ({ id: 'gemini' }));
  const complete = vi.fn(async (_req: any) => {
    // Echo back a lesson per key it was asked about.
    const lessons = Object.entries(lessonsByKey).map(([key, lesson]) => ({ key, lesson }));
    return { text: JSON.stringify({ lessons }), tokensUsed: 10, estimatedCost: 0, provider: 'gemini' };
  });
  return { complete, selectProvider };
}

// ═══════════════════════════════════════════════════════════

let memoryDir: string;
let store: LessonStore;
let learning: LearningService;

beforeEach(async () => {
  memoryDir = mkdtempSync(join(tmpdir(), 'authorclaw-learning-'));
  store = new LessonStore(memoryDir);
  await store.initialize();
  learning = new LearningService(store);
});

afterEach(() => {
  try { rmSync(memoryDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('LearningService.detectPatterns (pure code aggregation)', () => {
  it('groups revision findings by pass/category and counts them', () => {
    const patterns = learning.detectPatterns([revisionReport({ count: 5 })]);
    const p = patterns.find(p => p.key === 'revision:anti-slop/adverbs');
    expect(p).toBeTruthy();
    expect(p!.count).toBe(5);
    expect(p!.kind).toBe('revision');
    expect(p!.lessonCategory).toBe('writing_quality');
  });

  it('groups contradictions by taxonomy category', () => {
    const patterns = learning.detectPatterns([contradictionReport(4)]);
    const p = patterns.find(p => p.key === 'contradiction:TIMELINE');
    expect(p).toBeTruthy();
    expect(p!.count).toBe(4);
    expect(p!.severity).toBe('error');
  });

  it('groups character flags by character + issue', () => {
    const patterns = learning.detectPatterns([characterReport('Alice', 'off-voice', 3)]);
    const p = patterns.find(p => p.key === 'character:alice::off-voice');
    expect(p).toBeTruthy();
    expect(p!.count).toBe(3);
    expect(p!.lessonCategory).toBe('style_voice');
  });

  it('accumulates counts across MULTIPLE reports of the same pattern', () => {
    const patterns = learning.detectPatterns([
      revisionReport({ count: 3 }),
      revisionReport({ count: 4 }),
    ]);
    const p = patterns.find(p => p.key === 'revision:anti-slop/adverbs');
    expect(p!.count).toBe(7);
  });

  it('keeps the worst severity seen for a pattern', () => {
    const patterns = learning.detectPatterns([
      revisionReport({ count: 2, severity: 'info' }),
      revisionReport({ count: 2, severity: 'error' }),
    ]);
    const p = patterns.find(p => p.key === 'revision:anti-slop/adverbs');
    expect(p!.severity).toBe('error');
  });
});

describe('LearningService.learnFromReports — lesson creation', () => {
  it('turns a recurring pattern into a lesson written to the LessonStore', async () => {
    const outcome = await learning.learnFromReports({ projectId: 'p1', reports: [revisionReport({ count: 5 })] });
    expect(outcome.lessonsAdded.length).toBe(1);
    expect(outcome.patternsFound.length).toBeGreaterThan(0);
    // It landed in the durable store.
    const all = store.getAll();
    expect(all.length).toBe(1);
    expect(all[0].source).toBe('self-critique'); // coerced canonical source
    expect(all[0].goalId).toBe('p1');
    expect(all[0].category).toBe('writing_quality');
    // The outcome preserves the fine-grained provenance tag.
    expect(outcome.lessonsAdded[0].source).toBe('learned:revision');
  });

  it('does NOT create a lesson for a one-off (non-recurring) finding', async () => {
    const outcome = await learning.learnFromReports({ reports: [revisionReport({ count: 1 })] });
    expect(outcome.lessonsAdded.length).toBe(0);
    expect(store.getAll().length).toBe(0);
  });

  it('emits deterministic lesson text when NO AI is provided', async () => {
    const outcome = await learning.learnFromReports({ reports: [contradictionReport(3)] });
    expect(outcome.lessonsAdded.length).toBe(1);
    const text = outcome.lessonsAdded[0].text.toLowerCase();
    // Deterministic TIMELINE lesson mentions chronology and the frequency.
    expect(text).toContain('chronology');
    expect(text).toContain('flagged 3x');
  });

  it('uses the free-tier AI phrasing when provided (and selects the free "general" tier)', async () => {
    const ai = fakeAI({ 'revision:anti-slop/adverbs': 'Prefer strong verbs over -ly adverbs.' });
    const outcome = await learning.learnFromReports(
      { reports: [revisionReport({ count: 6 })] },
      ai.complete,
      ai.selectProvider,
    );
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(ai.selectProvider).toHaveBeenCalledWith('general'); // FREE tier
    expect(outcome.lessonsAdded[0].text).toContain('Prefer strong verbs over -ly adverbs.');
    // The persisted text carries a stable provenance tag (the dedup anchor).
    expect(outcome.lessonsAdded[0].text).toContain('[learned:revision/anti-slop/adverbs]');
  });

  it('falls back to deterministic text when the AI call throws', async () => {
    const selectProvider = vi.fn(() => ({ id: 'gemini' }));
    const complete = vi.fn(async () => { throw new Error('provider down'); });
    const outcome = await learning.learnFromReports(
      { reports: [contradictionReport(3)] },
      complete as any,
      selectProvider as any,
    );
    expect(outcome.lessonsAdded.length).toBe(1);
    expect(outcome.lessonsAdded[0].text.toLowerCase()).toContain('chronology');
  });
});

describe('LearningService.learnFromReports — dedupe', () => {
  it('learning the SAME pattern twice does not double-add; it bumps confidence', async () => {
    const first = await learning.learnFromReports({ reports: [revisionReport({ count: 5 })] });
    expect(first.lessonsAdded.length).toBe(1);
    expect(store.getAll().length).toBe(1);
    const confBefore = store.getAll()[0].confidence;

    const second = await learning.learnFromReports({ reports: [revisionReport({ count: 5 })] });
    expect(second.lessonsAdded.length).toBe(0);
    expect(second.lessonsSkippedDuplicate.length).toBe(1);
    expect(second.lessonsSkippedDuplicate[0].bumped).toBe(true);
    // Still only ONE lesson in the store.
    expect(store.getAll().length).toBe(1);
    // Confidence went up.
    expect(store.getAll()[0].confidence).toBeGreaterThan(confBefore);
  });

  it('dedup ignores the frequency count so 5x and 8x of the same lesson collapse', async () => {
    await learning.learnFromReports({ reports: [contradictionReport(3)] });
    expect(store.getAll().length).toBe(1);
    // A larger count → deterministic text differs only in "(flagged Nx)".
    const second = await learning.learnFromReports({ reports: [contradictionReport(8)] });
    expect(second.lessonsAdded.length).toBe(0);
    expect(second.lessonsSkippedDuplicate.length).toBe(1);
    expect(store.getAll().length).toBe(1);
  });

  it('dedupes on the stable pattern tag even when the AI PHRASES the lesson differently each run', async () => {
    // Run 1: AI phrases the adverbs pattern one way.
    const ai1 = fakeAI({ 'revision:anti-slop/adverbs': 'Prefer strong verbs over -ly adverbs.' });
    const first = await learning.learnFromReports(
      { reports: [revisionReport({ count: 4 })] }, ai1.complete, ai1.selectProvider,
    );
    expect(first.lessonsAdded.length).toBe(1);
    expect(store.getAll().length).toBe(1);

    // Run 2: SAME pattern, but the AI words it completely differently. Without a
    // stable anchor this would double-add; the provenance tag prevents it.
    const ai2 = fakeAI({ 'revision:anti-slop/adverbs': 'Swap weak adverbs for vivid, precise verbs whenever you can.' });
    const second = await learning.learnFromReports(
      { reports: [revisionReport({ count: 4 })] }, ai2.complete, ai2.selectProvider,
    );
    expect(second.lessonsAdded.length).toBe(0);
    expect(second.lessonsSkippedDuplicate.length).toBe(1);
    expect(second.lessonsSkippedDuplicate[0].bumped).toBe(true);
    expect(store.getAll().length).toBe(1); // still ONE lesson
  });
});

describe('LearningService.learnFromReports — robustness (never throws)', () => {
  it('returns a well-formed empty outcome for no reports', async () => {
    const outcome = await learning.learnFromReports({ reports: [] });
    expect(outcome.patternsFound).toEqual([]);
    expect(outcome.lessonsAdded).toEqual([]);
    expect(outcome.lessonsSkippedDuplicate).toEqual([]);
    expect(outcome.summary).toBeTruthy();
    expect(store.getAll().length).toBe(0);
  });

  it('tolerates malformed / null reports without throwing', async () => {
    const outcome = await learning.learnFromReports({
      reports: [
        null as any,
        { type: 'revision', report: null } as any,
        { type: 'revision', report: { findings: 'not-an-array' } } as any,
        { type: 'contradiction', report: {} } as any,
        { type: 'unknown', report: { findings: [] } } as any,
        // one good recurring pattern mixed in
        revisionReport({ count: 3 }),
      ],
    });
    // The one good pattern still produced a lesson; the junk was ignored.
    expect(outcome.lessonsAdded.length).toBe(1);
  });

  it('does not throw when the AI returns unparseable text (falls back)', async () => {
    const selectProvider = vi.fn(() => ({ id: 'gemini' }));
    const complete = vi.fn(async () => ({ text: 'not json at all {{{', tokensUsed: 0, estimatedCost: 0, provider: 'gemini' }));
    const outcome = await learning.learnFromReports(
      { reports: [revisionReport({ count: 4 })] },
      complete as any,
      selectProvider as any,
    );
    expect(outcome.lessonsAdded.length).toBe(1);
    // fell back to deterministic phrasing
    expect(outcome.lessonsAdded[0].text.length).toBeGreaterThan(0);
  });
});

describe('LearningService — LessonStore integration (persistence)', () => {
  it('persists learned lessons to the JSONL and they reload', async () => {
    await learning.learnFromReports({ reports: [revisionReport({ count: 4 }), contradictionReport(3)] });
    expect(store.getAll().length).toBe(2);

    // A fresh store over the same dir reloads the persisted lessons.
    const reloaded = new LessonStore(memoryDir);
    await reloaded.initialize();
    expect(reloaded.getAll().length).toBe(2);
  });

  it('learned lessons flow into the injected system-prompt context', async () => {
    const ai = fakeAI({ 'revision:anti-slop/adverbs': 'Prefer strong verbs over -ly adverbs.' });
    await learning.learnFromReports({ reports: [revisionReport({ count: 8 })] }, ai.complete, ai.selectProvider);
    // buildContext is exactly what message-pipeline injects into the prompt.
    const ctx = store.buildContext(500);
    expect(ctx).toContain('Prefer strong verbs over -ly adverbs.');
  });
});
