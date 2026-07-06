import { describe, it, expect } from 'vitest';
import {
  ProseEvolverService,
  DEFAULT_ROUNDS,
  MAX_ROUNDS,
  CALLS_PER_ROUND,
  MIN_PASSAGE_CHARS,
  PLATEAU_STOP,
  type EvolveDeps,
} from './prose-evolver.js';
import type { QualityVerdict } from './writing-judge.js';

// ═══════════════════════════════════════════════════════════
// Test doubles
// ═══════════════════════════════════════════════════════════

const SAMPLE = 'The sky was very blue. She walked quickly to the door. She was scared, and she suddenly realized that things were about to change dramatically for everyone.';

/** Build a minimal QualityVerdict with a controllable score. */
function verdict(score: number, opts: { withJudge?: boolean; feedback?: string } = {}): QualityVerdict {
  const withJudge = opts.withJudge !== false;
  return {
    score,
    retry: score < 70,
    mechanical: { wordCount: 30, issues: [], score: Math.min(100, score) },
    judge: withJudge
      ? { kind: 'craft', dimensions: [{ name: 'voice_consistency', score: score / 10, issues: ['x'] }], overall: score / 10, topIssues: [`[voice ${score / 10}/10] tighten it`] }
      : null,
    dualJudge: null,
    summary: `Score ${score}/100`,
    retryFeedback: opts.feedback ?? '- weak verbs\n- filter words',
  };
}

/**
 * A stubbed WritingJudge whose evaluate() returns scores from a caller-supplied
 * function. `scoreFor(text, callIndex)` lets a test decide the score by content
 * or by call order. Records every scored text for assertions.
 */
function makeJudge(scoreFor: (text: string, callIndex: number) => number, judgeOpts: { withJudge?: boolean } = {}) {
  const scoredTexts: string[] = [];
  let calls = 0;
  const judge: any = {
    async evaluate(text: string) {
      const idx = calls++;
      scoredTexts.push(text);
      return verdict(scoreFor(text, idx), judgeOpts);
    },
  };
  return { judge, scoredTexts, get scoreCalls() { return calls; } };
}

/**
 * A stubbed aiComplete. The reflect call (system contains "REFLECTION") returns
 * a diagnosis; the revise call returns `revise(userContent, callIndex)`. Records
 * every request so tests can assert on prompt content (e.g. voice instruction).
 */
function makeAI(revise: (userContent: string, callIndex: number) => string) {
  const requests: Array<{ system: string; user: string; provider: string }> = [];
  let reviseCalls = 0;
  const aiComplete = async (req: any) => {
    const user = req.messages?.[0]?.content ?? '';
    requests.push({ system: req.system, user, provider: req.provider });
    if (/REFLECTION/i.test(req.system)) {
      return { text: '1. Replace weak verbs.\n2. Cut filter words.\n3. Ground the fear in the body.' };
    }
    // revision call
    const idx = reviseCalls++;
    return { text: revise(user, idx) };
  };
  return { aiComplete, requests };
}

const selectProvider = (_t: string) => ({ id: 'mock-mid' });

function baseDeps(judge: any, aiComplete: any, extra: Partial<EvolveDeps> = {}): EvolveDeps {
  return {
    writingJudge: judge,
    aiComplete,
    aiSelectProvider: selectProvider,
    soul: null,
    memoryTier: null,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════
// estimateCalls
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.estimateCalls', () => {
  const svc = new ProseEvolverService();

  it('computes 1 initial score + CALLS_PER_ROUND per round', () => {
    expect(svc.estimateCalls(3)).toBe(1 + 3 * CALLS_PER_ROUND);
    expect(svc.estimateCalls(1)).toBe(1 + 1 * CALLS_PER_ROUND);
  });

  it('defaults to DEFAULT_ROUNDS when no argument is given', () => {
    expect(svc.estimateCalls()).toBe(1 + DEFAULT_ROUNDS * CALLS_PER_ROUND);
  });

  it('clamps rounds to the MAX_ROUNDS cap and a floor of 1', () => {
    expect(svc.estimateCalls(99)).toBe(1 + MAX_ROUNDS * CALLS_PER_ROUND);
    expect(svc.estimateCalls(0)).toBe(1 + 1 * CALLS_PER_ROUND);
    expect(svc.estimateCalls(-5)).toBe(1 + 1 * CALLS_PER_ROUND);
  });
});

// ═══════════════════════════════════════════════════════════
// Core loop: keeps a higher-scoring candidate
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — keeps improving candidates', () => {
  const svc = new ProseEvolverService();

  it('accepts a candidate that beats the running best and reports improvement', async () => {
    // Original scores 50; every revised candidate scores 80. Round 1 accepts.
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete } = makeAI((_u, i) => `REVISED-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 1 }, baseDeps(judge, aiComplete));

    expect(result.original.score).toBe(50);
    expect(result.best.score).toBe(80);
    expect(result.best.text).not.toBe(SAMPLE);
    expect(result.improved).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].accepted).toBe(true);
    expect(result.rounds[0].candidateScore).toBe(80);
  });

  it('climbs monotonically across rounds, keeping the best each time', async () => {
    // Score increases with each distinct candidate: 50 → 60 → 70.
    const scores = new Map<string, number>([[SAMPLE, 50]]);
    let next = 60;
    const { judge } = makeJudge((text) => {
      if (scores.has(text)) return scores.get(text)!;
      const s = next;
      next += 10;
      scores.set(text, s);
      return s;
    });
    let n = 0;
    const { aiComplete } = makeAI(() => `candidate-${n++}-${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 2 }, baseDeps(judge, aiComplete));

    expect(result.original.score).toBe(50);
    expect(result.best.score).toBe(70);
    expect(result.improved).toBe(true);
    expect(result.rounds.every(r => r.accepted)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// No-regression: rejects a lower-scoring candidate
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — no-regression / Pareto rule', () => {
  const svc = new ProseEvolverService();

  it('REJECTS a candidate that scores lower than the best and keeps the original', async () => {
    // Original 70; every candidate 40 (worse). Must never regress.
    const { judge } = makeJudge((text) => (text === SAMPLE ? 70 : 40));
    const { aiComplete } = makeAI((_u, i) => `WORSE-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 3 }, baseDeps(judge, aiComplete));

    expect(result.best.text).toBe(SAMPLE);      // original retained
    expect(result.best.score).toBe(70);
    expect(result.improved).toBe(false);
    // Every recorded round must be a rejection.
    expect(result.rounds.every(r => r.accepted === false)).toBe(true);
    expect(result.rounds.some(r => r.candidateScore === 40)).toBe(true);
  });

  it('rejects an equal-scoring candidate (strictly-better rule, not ≥)', async () => {
    const { judge } = makeJudge(() => 65); // original AND candidate both 65
    const { aiComplete } = makeAI(() => `EQUAL ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 2 }, baseDeps(judge, aiComplete));

    expect(result.best.text).toBe(SAMPLE);
    expect(result.improved).toBe(false);
    expect(result.rounds[0].accepted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Early stop after N non-improving rounds
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — plateau early-stop', () => {
  const svc = new ProseEvolverService();

  it(`stops after ${PLATEAU_STOP} consecutive non-improving rounds even when more are requested`, async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 70 : 40)); // never improves
    const { aiComplete } = makeAI((_u, i) => `no-better-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 5 }, baseDeps(judge, aiComplete));

    // Requested 5 rounds, but plateau stops it at PLATEAU_STOP.
    expect(result.rounds).toHaveLength(PLATEAU_STOP);
    expect(result.warnings.some(w => /plateau|non-improving/i.test(w))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Rounds cap
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — respects the rounds cap', () => {
  const svc = new ProseEvolverService();

  it('never runs more than MAX_ROUNDS even if a huge rounds value is passed', async () => {
    // Keep every round improving so plateau never triggers — only the cap can
    // bound the loop. Each distinct candidate scores strictly higher, staying
    // well under the 100 ceiling so we never plateau against the cap.
    let n = 20; // original is 10; candidates step 20,30,40,... (all < 100)
    const seen = new Map<string, number>([[SAMPLE, 10]]);
    const { judge } = makeJudge((text) => {
      if (seen.has(text)) return seen.get(text)!;
      const s = Math.min(95, n);
      n += 10;
      seen.set(text, s);
      return s;
    });
    let c = 0;
    const { aiComplete } = makeAI(() => `up-${c++}-${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 999 }, baseDeps(judge, aiComplete));

    expect(result.rounds.length).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(result.rounds.length).toBe(MAX_ROUNDS);
    // All five rounds should have been accepted (strictly climbing).
    expect(result.rounds.every(r => r.accepted)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Trace records each round
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — trace records each round', () => {
  const svc = new ProseEvolverService();

  it('records round number, candidateScore, accepted, reflection, and changeSummary per round', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 75));
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 1 }, baseDeps(judge, aiComplete));

    expect(result.rounds).toHaveLength(1);
    const r = result.rounds[0];
    expect(r.round).toBe(1);
    expect(typeof r.candidateScore).toBe('number');
    expect(typeof r.accepted).toBe('boolean');
    expect(r.reflection.length).toBeGreaterThan(0);       // reflection captured
    expect(r.changeSummary.length).toBeGreaterThan(0);    // human summary captured
    expect(typeof r.angle).toBe('string');
  });

  it('records the reflection text produced by the reflect step', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 75));
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);
    const result = await svc.evolve({ passage: SAMPLE, rounds: 1 }, baseDeps(judge, aiComplete));
    expect(result.rounds[0].reflection).toMatch(/weak verbs/i);
  });
});

// ═══════════════════════════════════════════════════════════
// Voice-preserve instruction present in the revise prompt
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — voice preservation', () => {
  const svc = new ProseEvolverService();

  it('injects the soul/style-guide and a PRESERVE VOICE instruction into the revise prompt when preserveVoice', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete, requests } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);
    const soul: any = { getFullContext: () => 'AUTHOR VOICE MARKER 12345: terse, wry, present-tense.' };

    const result = await svc.evolve(
      { passage: SAMPLE, rounds: 1, preserveVoice: true },
      baseDeps(judge, aiComplete, { soul }),
    );

    const reviseReq = requests.find(r => !/REFLECTION/i.test(r.system));
    expect(reviseReq).toBeDefined();
    expect(reviseReq!.system).toMatch(/PRESERVE THE AUTHOR'S VOICE/i);
    expect(reviseReq!.system).toContain('AUTHOR VOICE MARKER 12345'); // soul injected
    expect(result.voicePreserved).toBe(true);
  });

  it('still instructs voice preservation generically when no soul is available', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete, requests } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);

    const result = await svc.evolve(
      { passage: SAMPLE, rounds: 1, preserveVoice: true },
      baseDeps(judge, aiComplete, { soul: null }),
    );

    const reviseReq = requests.find(r => !/REFLECTION/i.test(r.system));
    expect(reviseReq!.system).toMatch(/PRESERVE THE AUTHOR'S VOICE/i);
    // No soul → voicePreserved false (no style context was actually injected).
    expect(result.voicePreserved).toBe(false);
  });

  it('omits the voice instruction when preserveVoice is explicitly false', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete, requests } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);
    const soul: any = { getFullContext: () => 'SHOULD NOT APPEAR' };

    const result = await svc.evolve(
      { passage: SAMPLE, rounds: 1, preserveVoice: false },
      baseDeps(judge, aiComplete, { soul }),
    );

    const reviseReq = requests.find(r => !/REFLECTION/i.test(r.system));
    expect(reviseReq!.system).not.toMatch(/PRESERVE THE AUTHOR'S VOICE/i);
    expect(reviseReq!.system).not.toContain('SHOULD NOT APPEAR');
    expect(result.voicePreserved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Never throws when the judge / AI throws
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — graceful degradation (never throws)', () => {
  const svc = new ProseEvolverService();

  it('returns the original as best (with a warning) when the judge always throws', async () => {
    const judge: any = { async evaluate() { throw new Error('judge network down'); } };
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 3 }, baseDeps(judge, aiComplete));

    expect(result.best.text).toBe(SAMPLE);
    expect(result.improved).toBe(false);
    expect(result.original.score).toBe(0);   // could not score → 0 baseline
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => /judge/i.test(w))).toBe(true);
  });

  it('returns the original as best (with a warning) when aiComplete always throws', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 90));
    const aiComplete = async () => { throw new Error('router exploded'); };

    const result = await svc.evolve({ passage: SAMPLE, rounds: 3 }, baseDeps(judge, aiComplete));

    // Reflection fails every round → no candidates → original retained.
    expect(result.best.text).toBe(SAMPLE);
    expect(result.improved).toBe(false);
    expect(result.warnings.some(w => /reflection/i.test(w))).toBe(true);
  });

  it('skips a round whose revision fails but keeps evolving on later rounds', async () => {
    // Original 50. Revision fails on round 1 (empty), succeeds on round 2 (→85).
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 85));
    let call = 0;
    const aiComplete = async (req: any) => {
      if (/REFLECTION/i.test(req.system)) return { text: '1. Do the thing.' };
      call++;
      if (call === 1) return { text: '' };            // revise fails round 1
      return { text: `RESCUED ${SAMPLE}` };           // revise ok round 2
    };

    const result = await svc.evolve({ passage: SAMPLE, rounds: 2 }, baseDeps(judge, aiComplete));

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].accepted).toBe(false);
    expect(result.rounds[1].accepted).toBe(true);
    expect(result.best.score).toBe(85);
    expect(result.improved).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Too-short passage
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — too-short passage is a safe no-op', () => {
  const svc = new ProseEvolverService();

  it(`skips the loop for a passage under ${MIN_PASSAGE_CHARS} chars and returns it unchanged`, async () => {
    const tiny = 'Too short.';
    const { judge, scoreCalls } = makeJudge(() => 50);
    const { aiComplete, requests } = makeAI(() => 'x');

    const result = await svc.evolve({ passage: tiny, rounds: 3 }, baseDeps(judge, aiComplete));

    expect(result.best.text).toBe(tiny);
    expect(result.rounds).toHaveLength(0);       // no rounds ran
    expect(requests.length).toBe(0);             // no reflect/revise calls
    expect(result.warnings.some(w => /too short/i.test(w))).toBe(true);
    // Only the initial baseline score call may have run.
    expect(scoreCalls).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════
// Cost accounting
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — cost accounting', () => {
  const svc = new ProseEvolverService();

  it('totalCalls stays within the estimateCalls upper bound', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);

    const rounds = 2;
    const result = await svc.evolve({ passage: SAMPLE, rounds }, baseDeps(judge, aiComplete));

    expect(result.totalCalls).toBeLessThanOrEqual(svc.estimateCalls(rounds));
    expect(result.totalCalls).toBeGreaterThan(0);
  });

  it('counts ~3 AI calls per round plus 1 baseline score for a single accepting round', async () => {
    // 1 baseline score + (1 reflect + 1 revise + 1 rescore) = 4 for one round.
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 1 }, baseDeps(judge, aiComplete));
    expect(result.totalCalls).toBe(1 + CALLS_PER_ROUND);
  });

  it('reports the revision provider id used', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 50 : 80));
    const { aiComplete } = makeAI((_u, i) => `rev-${i} ${SAMPLE}`);
    const result = await svc.evolve({ passage: SAMPLE, rounds: 1 }, baseDeps(judge, aiComplete));
    expect(result.provider).toBe('mock-mid');
  });
});

// ═══════════════════════════════════════════════════════════
// Reflection angle varies after a non-improving round
// ═══════════════════════════════════════════════════════════

describe('ProseEvolverService.evolve — reflection angle varies on non-improvement', () => {
  const svc = new ProseEvolverService();

  it('uses a different angle on the round after a rejection', async () => {
    const { judge } = makeJudge((text) => (text === SAMPLE ? 70 : 40)); // both rounds reject
    const { aiComplete } = makeAI((_u, i) => `worse-${i} ${SAMPLE}`);

    const result = await svc.evolve({ passage: SAMPLE, rounds: 2 }, baseDeps(judge, aiComplete));

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].angle).not.toBe(result.rounds[1].angle);
  });
});
