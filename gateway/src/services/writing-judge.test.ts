import { describe, it, expect } from 'vitest';
import { WritingJudgeService } from './writing-judge.js';

describe('WritingJudgeService.mechanicalScreen — AI-tell / cliche / lexicon regexes', () => {
  const svc = new WritingJudgeService();

  it('returns score 100 and no issues for clean prose with none of the flagged patterns', () => {
    const text = 'Mara crossed the room and shut the door behind her. Her hands shook.';
    const report = svc.mechanicalScreen(text);
    expect(report.issues).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.wordCount).toBeGreaterThan(0);
  });

  it('flags AI-tell phrases like "delve into" and "tapestry of"', () => {
    const text = 'The story continues to delve into the tapestry of human emotion across many chapters of narrative exploration and further discussion.';
    const report = svc.mechanicalScreen(text);
    const aiTell = report.issues.find(i => i.category === 'ai_tell');
    expect(aiTell).toBeDefined();
    expect(aiTell!.count).toBe(2);
  });

  it('flags banned cliche phrases like "tip of the iceberg"', () => {
    const text = 'This is just the tip of the iceberg, and at the end of the day it barely matters what happens next in this long chapter of prose.';
    const report = svc.mechanicalScreen(text);
    const cliche = report.issues.find(i => i.category === 'banned_phrase');
    expect(cliche).toBeDefined();
    expect(cliche!.count).toBe(2);
  });

  it('flags high filter-word density (saw/heard/felt/noticed/realized...)', () => {
    // Need rate > 8 per 1000 words. Use a short text so a handful of filter
    // words push the rate over threshold.
    const words = Array(20).fill('word').join(' ');
    const text = `${words} saw heard felt noticed realized wondered decided knew understood`;
    const report = svc.mechanicalScreen(text);
    const filter = report.issues.find(i => i.category === 'filter_word');
    expect(filter).toBeDefined();
    expect(filter!.count).toBe(9);
  });

  it('flags high adverb (-ly) density while excluding known false positives', () => {
    const words = Array(20).fill('word').join(' ');
    // "family", "only", "really" etc. must NOT count as adverbs.
    const text = `${words} quickly slowly quietly loudly softly boldly family only really`;
    const report = svc.mechanicalScreen(text);
    const adverb = report.issues.find(i => i.category === 'adverb_density');
    expect(adverb).toBeDefined();
    expect(adverb!.count).toBe(6); // quickly/slowly/quietly/loudly/softly/boldly only
  });

  it('flags passive voice constructions', () => {
    const words = Array(20).fill('word').join(' ');
    const text = `${words} it was finished and it was completed and it was decided and it was executed`;
    const report = svc.mechanicalScreen(text);
    const passive = report.issues.find(i => i.category === 'passive_voice');
    expect(passive).toBeDefined();
    expect(passive!.count).toBeGreaterThanOrEqual(4);
  });

  it('flags "started to" / "began to" constructions at count >= 3', () => {
    const text = 'She started to run. He began to shout. They started to panic while everyone else began to scatter across the field in fear.';
    const report = svc.mechanicalScreen(text);
    const startedTo = report.issues.find(i => i.category === 'started_to');
    expect(startedTo).toBeDefined();
    expect(startedTo!.count).toBe(4);
  });

  it('does not flag "started to" below the count >= 3 threshold', () => {
    const text = 'She started to run before stopping herself.';
    const report = svc.mechanicalScreen(text);
    expect(report.issues.find(i => i.category === 'started_to')).toBeUndefined();
  });

  it('flags "suddenly" at count >= 2', () => {
    const text = 'Suddenly the door opened. Suddenly the lights went out.';
    const report = svc.mechanicalScreen(text);
    const suddenly = report.issues.find(i => i.category === 'suddenly');
    expect(suddenly).toBeDefined();
    expect(suddenly!.count).toBe(2);
  });

  it('does not flag a single "suddenly"', () => {
    const text = 'Suddenly the door opened, and everyone turned to look at once.';
    const report = svc.mechanicalScreen(text);
    expect(report.issues.find(i => i.category === 'suddenly')).toBeUndefined();
  });

  it('flags high hedge-word density (perhaps/maybe/might/somewhat/rather)', () => {
    const words = Array(20).fill('word').join(' ');
    const text = `${words} perhaps maybe might possibly probably apparently somewhat rather quite`;
    const report = svc.mechanicalScreen(text);
    const hedge = report.issues.find(i => i.category === 'hedge_word');
    expect(hedge).toBeDefined();
    expect(hedge!.count).toBe(9);
  });

  it('deducts weighted penalties per issue severity from the composite score', () => {
    // A text riddled with multiple categories should score well below 100.
    const text = Array(10).fill(
      'Suddenly she started to delve into the tapestry of the tip of the iceberg. Suddenly she began to realize she saw and heard and felt and noticed things, perhaps rather quietly.'
    ).join(' ');
    const report = svc.mechanicalScreen(text);
    expect(report.score).toBeLessThan(100);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('never returns a score below 0 even with heavy issue counts', () => {
    // Enormous problematic text to try to blow past a floor of 0.
    const badLine = 'Suddenly she started to delve into the tapestry of the tip of the iceberg, and it was finished, perhaps.';
    const text = Array(200).fill(badLine).join(' ');
    const report = svc.mechanicalScreen(text);
    expect(report.score).toBeGreaterThanOrEqual(0);
  });

  it('wordCount reflects whitespace-split token count', () => {
    const report = svc.mechanicalScreen('one two three four five');
    expect(report.wordCount).toBe(5);
  });

  it('wordCount is at least 1 even for an empty string (avoids div-by-zero in rate calcs)', () => {
    const report = svc.mechanicalScreen('');
    expect(report.wordCount).toBe(1);
  });
});

describe('WritingJudgeService.evaluate — mechanical-only fallback (no AI functions provided)', () => {
  const svc = new WritingJudgeService();

  it('produces a mechanical-only verdict when no aiComplete/aiSelectProvider are given', async () => {
    const verdict = await svc.evaluate('Clean simple prose with no issues at all in this sentence.');
    expect(verdict.judge).toBeNull();
    expect(verdict.dualJudge).toBeNull();
    expect(verdict.score).toBe(verdict.mechanical.score);
    expect(verdict.summary).toContain('mechanical-only');
  });

  it('marks retry=true when mechanical-only score falls below the threshold', async () => {
    const badText = Array(50).fill(
      'Suddenly she started to delve into the tapestry of the tip of the iceberg, and it was finished, perhaps rather quietly.'
    ).join(' ');
    const verdict = await svc.evaluate(badText, { threshold: 70 });
    expect(verdict.retry).toBe(verdict.score < 70);
  });

  it('respects a custom threshold', async () => {
    const verdict = await svc.evaluate('Clean simple prose with no issues at all in this sentence.', { threshold: 101 });
    // Threshold impossible to meet (>100) -> must always retry.
    expect(verdict.retry).toBe(true);
  });
});

describe('WritingJudgeService.evaluate — with a mocked AI judge (smoke test)', () => {
  // TODO: deeper coverage — llmJudge's JSON-parsing fallback paths (code-fence
  // stripping, trailing-comma repair, non-JSON response, dimension validation)
  // are not exhaustively covered here. This smoke test verifies the
  // single-judge and dual-judge wiring end-to-end with a controlled mock
  // response, which is the main integration risk for this module's async path.
  const svc = new WritingJudgeService();

  function mockAIComplete(dimensionsJson: object) {
    return async () => ({ text: JSON.stringify(dimensionsJson) });
  }
  const mockSelectProvider = (taskType: string) => ({ id: 'mock-provider' });

  it('runs the single (craft) judge and blends mechanical + judge scores', async () => {
    const aiComplete = mockAIComplete({
      dimensions: [
        { name: 'voice_consistency', score: 8, issues: ['solid voice'] },
        { name: 'show_vs_tell', score: 7, issues: ['mostly shown'] },
      ],
    });
    const verdict = await svc.evaluate('Clean prose with no mechanical issues whatsoever in this sentence.', {
      aiComplete,
      aiSelectProvider: mockSelectProvider,
    });
    expect(verdict.judge).not.toBeNull();
    expect(verdict.judge!.kind).toBe('craft');
    expect(verdict.judge!.overall).toBeCloseTo(7.5, 5);
    expect(verdict.dualJudge).toBeNull();
    // combined = mechanical*0.3 + judgeScore100*0.7; mechanical is 100 for clean text.
    expect(verdict.score).toBeCloseTo(100 * 0.3 + 75 * 0.7, 5);
  });

  it('runs dual judge mode and computes combinedOverall100 + disagreementGap', async () => {
    let call = 0;
    const aiComplete = async () => {
      call++;
      if (call === 1) {
        return { text: JSON.stringify({ dimensions: [{ name: 'voice_consistency', score: 9, issues: ['great'] }] }) };
      }
      return { text: JSON.stringify({ dimensions: [{ name: 'hook_strength', score: 3, issues: ['weak hook'] }] }) };
    };
    const verdict = await svc.evaluate('Clean prose with no mechanical issues whatsoever in this sentence.', {
      aiComplete,
      aiSelectProvider: mockSelectProvider,
      dualJudge: true,
    });
    expect(verdict.dualJudge).not.toBeNull();
    expect(verdict.judge).toBeNull();
    // gap = |9 - 3| * 10 = 60 -> large disagreement -> note should mention it.
    expect(verdict.dualJudge!.disagreementGap).toBeCloseTo(60, 5);
    expect(verdict.retryFeedback).toContain('disagree');
  });

  it('falls back to mechanical-only when the AI call throws', async () => {
    const aiComplete = async () => { throw new Error('network down'); };
    const verdict = await svc.evaluate('Clean prose with no mechanical issues whatsoever in this sentence.', {
      aiComplete,
      aiSelectProvider: mockSelectProvider,
    });
    expect(verdict.judge).toBeNull();
    expect(verdict.score).toBe(verdict.mechanical.score);
  });

  it('returns null from llmJudge (and falls back) when the AI response is not JSON', async () => {
    const aiComplete = async () => ({ text: 'Sorry, I cannot help with that.' });
    const verdict = await svc.evaluate('Clean prose with no mechanical issues whatsoever in this sentence.', {
      aiComplete,
      aiSelectProvider: mockSelectProvider,
    });
    expect(verdict.judge).toBeNull();
  });
});
