import { describe, it, expect, vi } from 'vitest';
import { ReaderPanelService } from './reader-panel.js';

const svc = new ReaderPanelService();

// A permissive select-provider stub used across tests.
const selectProvider = (_taskType: string) => ({ id: 'mock-provider' });

// ═══════════════════════════════════════════════════════════
// Panel generation
// ═══════════════════════════════════════════════════════════

describe('ReaderPanelService.buildPanel — demographic variety', () => {
  it('produces the requested number of personas with stable ids', () => {
    const panel = svc.buildPanel('cozy fantasy', 6);
    expect(panel).toHaveLength(6);
    expect(panel.map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('varies price sensitivity, discovery mode, and sub-genre affinity across the panel', () => {
    const panel = svc.buildPanel('cozy fantasy', 6);
    const prices = new Set(panel.map(p => p.priceSensitivity));
    const discovery = new Set(panel.map(p => p.discovery));
    const affinities = new Set(panel.map(p => p.notes));
    // All three price bands should appear in a 6-person panel.
    expect(prices).toEqual(new Set(['low', 'med', 'high']));
    // Multiple discovery modes should appear (not all identical).
    expect(discovery.size).toBeGreaterThanOrEqual(3);
    // Sub-genre affinities should span the genre's pool (not one repeated line).
    expect(affinities.size).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic — same (genre,size) yields an identical panel (no Math.random)', () => {
    const a = svc.buildPanel('thriller', 5);
    const b = svc.buildPanel('thriller', 5);
    expect(a).toEqual(b);
  });

  it('routes unknown genres to a generic commercial-fiction pool', () => {
    const panel = svc.buildPanel('interpretive underwater basket weaving memoir', 4);
    expect(panel).toHaveLength(4);
    // Generic pool still varies price sensitivity.
    expect(new Set(panel.map(p => p.priceSensitivity)).size).toBeGreaterThanOrEqual(2);
  });

  it('picks genre-specific axes (fantasy age bands differ from thriller)', () => {
    const fantasy = svc.buildPanel('epic fantasy', 4);
    const thriller = svc.buildPanel('domestic thriller', 4);
    // Fantasy pool starts at 18-24; thriller pool starts at 25-34.
    expect(fantasy[0].ageBand).toBe('18-24');
    expect(thriller[0].ageBand).toBe('25-34');
  });
});

// ═══════════════════════════════════════════════════════════
// Tournament aggregation with crafted votes
// ═══════════════════════════════════════════════════════════

/**
 * Parse the per-persona A/B blocks out of a matchup prompt. The service shows
 * each persona its own (possibly swapped) A/B pair, so the letter a persona
 * "sees" for a given candidate varies. Returns, per persona, the candidate
 * text in its A slot and B slot.
 */
function parsePersonaBlocks(prompt: string): Array<{ id: string; aText: string; bText: string }> {
  const out: Array<{ id: string; aText: string; bText: string }> = [];
  const re = /- (p\d+) \([^\n]*\)\n {4}A: (.*)\n {4}B: (.*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push({ id: m[1], aText: m[2].trim(), bText: m[3].trim() });
  }
  return out;
}

/**
 * Build a stub aiComplete that decides each persona's vote by CANDIDATE TEXT
 * (order-independent), honoring the per-persona A/B swap the service applies.
 * `pickCandidate(personaId, index)` returns the candidate TEXT that persona
 * should vote for; the helper maps it to the correct A/B letter that persona saw.
 */
function craftedAIComplete(
  pickCandidate: (personaId: string, index: number, aText: string, bText: string) => { text: string; reason: string },
) {
  return async (req: { messages: Array<{ content: string }> }) => {
    const userPrompt = req.messages[0].content;
    const blocks = parsePersonaBlocks(userPrompt);
    const votes = blocks.map((blk, i) => {
      const choice = pickCandidate(blk.id, i, blk.aText, blk.bText);
      const winner = choice.text === blk.aText ? 'A' : 'B';
      return { personaId: blk.id, winner, reason: choice.reason };
    });
    return { text: JSON.stringify({ votes }) };
  };
}

describe('ReaderPanelService.runTournament — aggregation + ranking', () => {
  it('ranks the candidate that wins every matchup as the winner', async () => {
    // Every persona votes for "WINNER blurb" regardless of which slot it's in.
    // With 2 candidates, single-elim = 1 matchup [0,1].
    const aiComplete = craftedAIComplete((id) => ({
      text: 'WINNER blurb',
      reason: `persona ${id} prefers the sentient sourdough hook`,
    }));
    const report = await svc.runTournament(
      { candidates: ['WINNER blurb', 'LOSER blurb'], kind: 'blurb', genre: 'cozy fantasy' },
      aiComplete, selectProvider,
    );
    expect(report.matchupsRun).toBe(1);
    expect(report.winner).toBe('WINNER blurb');
    expect(report.ranking[0].candidate).toBe('WINNER blurb');
    expect(report.ranking[0].winRate).toBe(1);
    expect(report.ranking[1].winRate).toBe(0);
  });

  it('computes fractional win-rates and per-candidate segment preferences', async () => {
    // 3 candidates → single-elim pairings [0,1] and [1,2].
    // Matchup [0,1]: everyone votes C0 (C0 wins, C1 loses).
    // Matchup [1,2]: everyone votes C1 (C1 wins, C2 loses).
    // C1 appears in both matchups: loses first, wins second → 0.5.
    const varied = [
      'the punchier verb choice grabs me', 'sharper imagery in this one',
      'the rhythm reads better aloud', 'more intrigue in these words',
      'cleaner and more memorable phrasing', 'the tone fits my shelf',
    ];
    const aiComplete = craftedAIComplete((id, i, aText, bText) => {
      // Prefer C0 over C1, and C1 over C2 (i.e. lower-numbered candidate wins).
      const pickLower = (x: string, y: string) => (x <= y ? x : y);
      return { text: pickLower(aText, bText), reason: `${varied[i % varied.length]} (${id})` };
    });
    const report = await svc.runTournament(
      { candidates: ['C0', 'C1', 'C2'], kind: 'title', genre: 'thriller' },
      aiComplete, selectProvider,
    );
    expect(report.matchupsRun).toBe(2);
    const byName = Object.fromEntries(report.ranking.map(r => [r.candidate, r.winRate]));
    expect(byName['C0']).toBe(1);    // won its only matchup
    expect(byName['C1']).toBe(0.5);  // lost one, won one
    expect(byName['C2']).toBe(0);    // lost its only matchup
    const c0 = report.ranking.find(r => r.candidate === 'C0')!;
    expect(c0.segmentPreference).toMatch(/price|discovery/);
  });

  it('surfaces the PanelReport shape with all required fields', async () => {
    const aiComplete = craftedAIComplete((id, i, aText, bText) => ({
      text: i % 2 === 0 ? aText : bText,
      reason: `${id} weighs the tradeoff differently number ${i}`,
    }));
    const report = await svc.runTournament(
      { candidates: ['Alpha', 'Beta'], kind: 'concept', genre: 'romance' },
      aiComplete, selectProvider,
    );
    expect(report).toMatchObject({
      kind: 'concept',
      genre: 'romance',
    });
    expect(typeof report.panelSize).toBe('number');
    expect(Array.isArray(report.ranking)).toBe(true);
    expect(typeof report.confidence).toBe('number');
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(typeof report.matchupsRun).toBe('number');
    for (const r of report.ranking) {
      expect(r).toHaveProperty('candidate');
      expect(r).toHaveProperty('winRate');
      expect(r).toHaveProperty('segmentPreference');
      expect(Array.isArray(r.sampleReasons)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Anti-slop safeguards
// ═══════════════════════════════════════════════════════════

describe('ReaderPanelService — anti-slop safeguards', () => {
  it('(a) score-clustering: flags "panel not discriminating" when votes are near-uniform', async () => {
    // Split the panel ~50/50 by real candidate (first half → Blurb A, second
    // half → Blurb B), with varied reasons (so repetition doesn't also fire).
    // Win-rates cluster around 0.5 → clustering flag fires, confidence drops.
    const variedReasons = [
      'the whimsical bakery premise wins me over',
      'stronger stakes make the second option pop',
      'the voice here feels fresher and warmer somehow',
      'clearer hook, I know exactly what I am buying',
      'the magic-returns angle is more original to me',
      'cozier tone matches what I reach for on a Sunday',
    ];
    const aiComplete = craftedAIComplete((id, i) => ({
      text: i < 3 ? 'Blurb A' : 'Blurb B',
      reason: variedReasons[i % variedReasons.length],
    }));
    const report = await svc.runTournament(
      { candidates: ['Blurb A', 'Blurb B'], kind: 'blurb', genre: 'cozy fantasy', panelSize: 6 },
      aiComplete, selectProvider,
    );
    expect(report.warnings.some(w => /not discriminating/i.test(w))).toBe(true);
    expect(report.confidence).toBeLessThan(0.8);
  });

  it('(b) repetition/templating: flags judge collapse on near-duplicate reasons', async () => {
    // Every persona returns the SAME reason → Jaccard ~1 across all pairs.
    const aiComplete = craftedAIComplete((id, i, aText, bText) => ({
      text: i % 2 === 0 ? aText : bText,
      reason: 'this blurb is simply catchier and more engaging overall',
    }));
    const report = await svc.runTournament(
      { candidates: ['Blurb A', 'Blurb B'], kind: 'blurb', genre: 'cozy fantasy' },
      aiComplete, selectProvider,
    );
    expect(report.warnings.some(w => /judge collapse|near-duplicate/i.test(w))).toBe(true);
  });

  it('(c) position-bias mitigation: candidate order is genuinely swapped across personas', async () => {
    // Capture the single matchup prompt and confirm the SAME candidate text
    // appears in slot A for some personas and slot B for others — i.e. the
    // presented order is really swapped, not just relabeled after the fact.
    let capturedPrompt = '';
    const aiComplete = async (req: { messages: Array<{ content: string }> }) => {
      capturedPrompt = req.messages[0].content;
      const blocks = parsePersonaBlocks(capturedPrompt);
      // Everyone votes for the candidate literally named "First".
      return {
        text: JSON.stringify({
          votes: blocks.map((b, i) => ({
            personaId: b.id,
            winner: b.aText === 'First' ? 'A' : 'B',
            reason: `persona choice with a genuinely distinct rationale number ${i}`,
          })),
        }),
      };
    };
    const report = await svc.runTournament(
      { candidates: ['First', 'Second'], kind: 'blurb', genre: 'cozy fantasy', panelSize: 6 },
      aiComplete, selectProvider,
    );
    // The prompt must enumerate all 6 personas (batched single call).
    const blocks = parsePersonaBlocks(capturedPrompt);
    expect(blocks).toHaveLength(6);
    // The swap is real: "First" is in slot A for some personas and slot B for
    // others across the panel.
    const firstInA = blocks.filter(b => b.aText === 'First').length;
    const firstInB = blocks.filter(b => b.bText === 'First').length;
    expect(firstInA).toBeGreaterThan(0);
    expect(firstInB).toBeGreaterThan(0);
    // Everyone picked the same real candidate ("First"), so "First" wins 100%
    // but the FIRST-POSITION win rate sits near 0.5 → no position-bias warning.
    expect(report.winner).toBe('First');
    expect(report.warnings.some(w => /position bias/i.test(w))).toBe(false);
  });

  it('(d) confidence: a clean, discriminating, varied panel yields high confidence and no warnings', async () => {
    // Candidate 0 wins decisively with DISTINCT reasons per persona → no
    // clustering, no repetition, balanced position → high confidence.
    const reasons = [
      'the sentient sourdough line is an instant page-one hook for me',
      'found-family warmth is exactly my cozy comfort read',
      'low-stakes magic keeps me relaxed, I want this on my nightstand',
      'the bakery setting is charming and specific, not generic',
      'promise of gentle whimsy sells it over the darker option',
      'a talking loaf? sold, that voice is delightful and fresh',
    ];
    const aiComplete = craftedAIComplete((id, i) => ({
      text: 'Sentient sourdough blurb',
      reason: reasons[i % reasons.length],
    }));
    const report = await svc.runTournament(
      { candidates: ['Sentient sourdough blurb', 'Generic blurb'], kind: 'blurb', genre: 'cozy fantasy', panelSize: 6 },
      aiComplete, selectProvider,
    );
    expect(report.confidence).toBeGreaterThan(0.6);
    expect(report.warnings).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Graceful handling
// ═══════════════════════════════════════════════════════════

describe('ReaderPanelService — graceful degradation', () => {
  it('handles < 2 candidates without throwing (empty tournament, warning)', async () => {
    const aiComplete = vi.fn(async () => ({ text: '{}' }));
    const report = await svc.runTournament(
      { candidates: ['only one'], kind: 'blurb', genre: 'cozy fantasy' },
      aiComplete, selectProvider,
    );
    expect(report.matchupsRun).toBe(0);
    expect(report.warnings.some(w => /at least 2/i.test(w))).toBe(true);
    expect(report.confidence).toBe(0);
    // No AI calls should be made when there's nothing to compare.
    expect(aiComplete).not.toHaveBeenCalled();
  });

  it('handles malformed AI output without throwing (no usable votes → warning)', async () => {
    const aiComplete = async () => ({ text: 'not json at all, sorry' });
    const report = await svc.runTournament(
      { candidates: ['A', 'B'], kind: 'blurb', genre: 'cozy fantasy' },
      aiComplete, selectProvider,
    );
    // Ranking still returns (win-rates 0) and a warning about empty matchups.
    expect(report.ranking).toHaveLength(2);
    expect(report.warnings.some(w => /no usable votes/i.test(w))).toBe(true);
  });

  it('does not throw when the AI call itself rejects', async () => {
    const aiComplete = async () => { throw new Error('provider exploded'); };
    await expect(
      svc.runTournament(
        { candidates: ['A', 'B'], kind: 'blurb', genre: 'cozy fantasy' },
        aiComplete, selectProvider,
      ),
    ).resolves.toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// Cost discipline — cheap tier + batched calls
// ═══════════════════════════════════════════════════════════

describe('ReaderPanelService — cost discipline', () => {
  it('requests the cheap FREE tier ("marketing") for persona judgments', async () => {
    const spy = vi.fn((_taskType: string) => ({ id: 'mock-provider' }));
    const aiComplete = craftedAIComplete((id, i, aText, bText) => ({
      text: i % 2 === 0 ? aText : bText,
      reason: `${id} distinct reason number ${i}`,
    }));
    await svc.runTournament(
      { candidates: ['A', 'B'], kind: 'blurb', genre: 'cozy fantasy' },
      aiComplete, spy,
    );
    expect(spy).toHaveBeenCalledWith('marketing');
  });

  it('makes exactly N-1 AI calls for N candidates (single-elim, batched personas)', async () => {
    const aiComplete = vi.fn(craftedAIComplete((id, i, aText, bText) => ({
      text: i % 2 === 0 ? aText : bText,
      reason: `${id} varied reason ${i}`,
    })));
    await svc.runTournament(
      { candidates: ['C0', 'C1', 'C2', 'C3'], kind: 'title', genre: 'thriller' },
      aiComplete, selectProvider,
    );
    // 4 candidates → 3 matchups → 3 batched calls (one per matchup).
    expect(aiComplete).toHaveBeenCalledTimes(3);
  });
});
