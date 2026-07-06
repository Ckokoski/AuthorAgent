import { describe, it, expect, vi } from 'vitest';
import { CharacterAgentService } from './character-agent.js';
import type { EntityEntry, ChapterSummary } from './context-engine.js';
import type { StyleProfile } from './style-clone.js';

// ═══════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════

function makeEntities(): EntityEntry[] {
  return [
    {
      name: 'Kai',
      type: 'character',
      aliases: ['the kid'],
      description: 'A terse, plain-spoken street mechanic.',
      firstAppearance: 'c1',
      lastSeen: 'c3',
      attributes: { register: 'blunt', wants: 'to leave the city' },
      changes: [{ chapterId: 'c2', description: 'wants changed from "stay" to "leave the city"' }],
    },
    {
      name: 'Professor Vane',
      type: 'character',
      aliases: [],
      description: 'A verbose academic who over-explains.',
      firstAppearance: 'c3',
      lastSeen: 'c3',
      attributes: { register: 'ornate' },
      changes: [],
    },
    {
      name: 'The Grid',
      type: 'location',
      aliases: [],
      description: 'A dying system of servers.',
      firstAppearance: 'c1',
      lastSeen: 'c3',
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
      title: 'The Garage',
      summary: 'Kai fixes an engine and meets a stranger.',
      wordCount: 1000,
      characters: ['Kai'],
      locations: ['The Grid'],
      timelineMarker: 'Day 1',
      plotThreads: ['the stranger'],
      endingState: 'Kai takes a mysterious job.',
    },
    {
      chapterId: 'c2',
      chapterNumber: 2,
      title: 'The Betrayal',
      summary: 'The stranger betrays someone; a secret meeting happens in the tower.',
      wordCount: 1100,
      characters: ['Professor Vane'], // Kai is ABSENT here
      locations: ['The Grid'],
      timelineMarker: 'Day 2',
      plotThreads: ['the betrayal'],
      endingState: 'Vane learns the tower code.',
    },
    {
      chapterId: 'c3',
      chapterNumber: 3,
      title: 'Reunion',
      summary: 'Kai and Vane finally meet.',
      wordCount: 1200,
      characters: ['Kai', 'Professor Vane'],
      locations: ['The Grid'],
      timelineMarker: 'Day 3',
      plotThreads: ['the betrayal', 'the stranger'],
      endingState: 'They form an uneasy alliance.',
    },
  ];
}

/** A chapter with two named speakers, Kai (>=3 lines) and Vane (>=3 lines). */
const CHAPTER_TEXT = `
The garage smelled of oil.

"Get out," Kai said.

"Whatever you say."

"I mean it. Now."

"On the contrary, my dear boy, I must insist upon elucidating the multifarious ramifications of our present predicament," Professor Vane said.

"Indeed, one might postulate that the tower's cryptographic schema is anything but trivial."

"Furthermore, permit me to expound at considerable length."

Some narration in between with no quotes at all.
`;

/** A stubbed aiComplete returning a fixed body; records requests for assertions. */
function makeAiComplete(body: string) {
  return vi.fn(async (_req: any) => ({
    text: body,
    tokensUsed: 50,
    estimatedCost: 0,
    provider: 'stub',
  }));
}

/** A recording aiSelectProvider — captures requested task types. */
function makeAiSelect() {
  const calls: string[] = [];
  const fn = vi.fn((taskType: string) => {
    calls.push(taskType);
    return { id: 'stub-provider' };
  });
  return { fn, calls };
}

function makeFingerprint(overrides: Partial<StyleProfile['markers']> = {}): StyleProfile {
  const markers: any = {
    avgSentenceLength: 6, sentenceLengthStdDev: 2, medianSentenceLength: 5,
    shortSentencePct: 80, mediumSentencePct: 18, longSentencePct: 2,
    fragmentRate: 30, sentencesPerParagraph: 1.5,
    avgWordLength: 4.1, uniqueWordRatio: 0.7, rareWordRate: 5, syllableComplexity: 1.3,
    latinateRatio: 2, germanicRatio: 40, fleschReadingEase: 90, vocabSize: 120, repetitionIndex: 10,
    emDashRate: 1, semicolonRate: 0, colonRate: 0, ellipsisRate: 1, questionMarkRate: 5,
    exclamationRate: 2, parentheticalRate: 0, commaRate: 20,
    passiveVoiceRate: 1, compoundSentenceRate: 3, subordinateRate: 1, startsWithConjunctionPct: 5,
    participialPhrasePct: 1, relativePronounRate: 2, parallelStructureRate: 1,
    prepositionalDensity: 1, nominalizationRate: 1,
    contractionRate: 40, filterWordRate: 2, dialogueDensity: 0.9, adverbRate: 3,
    firstPersonPronounRate: 30, secondPersonPronounRate: 20, thirdPersonPronounRate: 10,
    sensoryDensity: 2, abstractConcreteRatio: 0.3, presentTenseRate: 5, pastTenseRate: 30,
    hedgingRate: 1, intensifierRate: 1,
    ...overrides,
  };
  return {
    generatedAt: new Date().toISOString(),
    sampleWordCount: 400,
    sampleSource: 'character:Kai',
    markers,
    systemPrompt: 'Write like Kai.',
    signature: 'Terse, blunt, contraction-heavy.',
  };
}

/** A JSON body flagging Vane's ornate line as off-voice for Kai (used generically). */
const KAI_FLAGS = JSON.stringify({
  flags: [
    {
      line: 'On the contrary, my dear boy',
      issue: 'off-voice',
      reason: 'Kai is terse and blunt; this ornate phrasing is out of register.',
      suggestion: 'No.',
    },
  ],
});

// ═══════════════════════════════════════════════════════════
// buildCharacterBrief — pure assembly
// ═══════════════════════════════════════════════════════════

describe('CharacterAgentService.buildCharacterBrief', () => {
  it('assembles voice + attributes + arc + relationships from the entity and summaries', () => {
    const agent = new CharacterAgentService();
    const [kai] = makeEntities();
    const fp = makeFingerprint();

    const brief = agent.buildCharacterBrief(kai, makeSummaries(), fp);

    expect(brief.name).toBe('Kai');
    expect(brief.aliases).toEqual(['the kid']);
    expect(brief.description).toContain('terse');
    // Attributes carried through.
    expect(brief.attributes).toEqual({ register: 'blunt', wants: 'to leave the city' });
    // Arc = the entity change-log.
    expect(brief.arc).toHaveLength(1);
    expect(brief.arc[0].description).toContain('leave the city');
    // Relationship: Vane co-appears with Kai in c3.
    expect(brief.knownRelationships).toContain('Professor Vane');
    // Fingerprint present → voice signature populated.
    expect(brief.hasFingerprint).toBe(true);
    expect(brief.voiceSignature).toContain('contractions');
    expect(brief.voiceSignature).toContain('Terse');
  });

  it('derives the knowledge horizon from chapters the character appears in', () => {
    const agent = new CharacterAgentService();
    const [kai] = makeEntities();

    const brief = agent.buildCharacterBrief(kai, makeSummaries());

    // Kai is in c1 and c3 but NOT c2 (the betrayal / tower-code chapter).
    expect(brief.knowledgeHorizon.chaptersPresent).toEqual([1, 3]);
    expect(brief.knowledgeHorizon.latestChapterPresent).toBe(3);
    // Known events cover only the chapters Kai was present for.
    const joined = brief.knowledgeHorizon.knownEvents.join(' | ');
    expect(joined).toContain('The Garage');
    expect(joined).toContain('Reunion');
    // Crucially, the ABSENT chapter (c2, the tower-code betrayal) is NOT in the
    // horizon — so Kai can't know the tower code.
    expect(joined).not.toContain('Betrayal');
    expect(joined).not.toContain('tower code');
  });

  it('marks hasFingerprint false and leaves voiceSignature empty when no fingerprint', () => {
    const agent = new CharacterAgentService();
    const [kai] = makeEntities();
    const brief = agent.buildCharacterBrief(kai, makeSummaries(), null);
    expect(brief.hasFingerprint).toBe(false);
    expect(brief.voiceSignature).toBe('');
  });

  it('handles a character absent from every summary (empty horizon, no throw)', () => {
    const agent = new CharacterAgentService();
    const ghost: EntityEntry = {
      name: 'Nobody', type: 'character', aliases: [], description: 'Unseen.',
      firstAppearance: 'c9', lastSeen: 'c9', attributes: {}, changes: [],
    };
    const brief = agent.buildCharacterBrief(ghost, makeSummaries());
    expect(brief.knowledgeHorizon.chaptersPresent).toEqual([]);
    expect(brief.knowledgeHorizon.latestChapterPresent).toBe(0);
    expect(brief.knownRelationships).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// critiqueDialogue — extraction, per-character calls, typed flags
// ═══════════════════════════════════════════════════════════

describe('CharacterAgentService.critiqueDialogue', () => {
  it('produces a typed report with per-character flags from stubbed AI', async () => {
    const agent = new CharacterAgentService();
    const aiComplete = makeAiComplete(KAI_FLAGS);
    const { fn: aiSelect } = makeAiSelect();

    const report = await agent.critiqueDialogue(
      { projectId: 'project-13', chapterText: CHAPTER_TEXT, chapterId: 'c3' },
      aiComplete,
      aiSelect,
      makeEntities(),
      makeSummaries(),
    );

    expect(report.projectId).toBe('project-13');
    expect(report.chapterId).toBe('c3');
    // Both Kai and Vane speak >=3 lines, so both are reviewed.
    expect(report.charactersReviewed.sort()).toEqual(['Kai', 'Professor Vane']);
    // Each reviewed character got one AI call.
    expect(aiComplete).toHaveBeenCalledTimes(2);
    // Every flag is well-typed.
    for (const block of report.byCharacter) {
      for (const flag of block.flags) {
        expect(['off-voice', 'anachronistic-knowledge', 'off-motivation']).toContain(flag.issue);
        expect(typeof flag.line).toBe('string');
        expect(flag.reason.length).toBeGreaterThan(0);
      }
    }
    expect(report.totalFlags).toBe(report.byCharacter.reduce((s, c) => s + c.flags.length, 0));
  });

  it('runs ONE style_analysis-tier call per character (mid tier, never premium)', async () => {
    const agent = new CharacterAgentService();
    const { fn: aiSelect, calls } = makeAiSelect();

    await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT },
      makeAiComplete('{"flags":[]}'),
      aiSelect,
      makeEntities(),
      makeSummaries(),
    );

    // Two reviewed characters → two tier selections, both 'style_analysis'.
    expect(calls).toEqual(['style_analysis', 'style_analysis']);
    expect(calls).not.toContain('final_edit');
  });

  it('feeds the knowledge horizon into each character prompt', async () => {
    const agent = new CharacterAgentService();
    const aiComplete = makeAiComplete('{"flags":[]}');

    await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT },
      aiComplete,
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );

    // Find the call whose brief is Kai's.
    const kaiCall = aiComplete.mock.calls.find((c) =>
      (c[0].messages[0].content as string).includes('CHARACTER BRIEF: Kai'),
    );
    expect(kaiCall).toBeTruthy();
    const content = kaiCall![0].messages[0].content as string;
    expect(content).toContain('KNOWLEDGE HORIZON');
    // Kai present in 1 and 3, so "up to chapter 3" and NOT chapter 2's tower code.
    expect(content).toContain('chapter 3');
    expect(content).not.toContain('tower code');
    // His actual lines are numbered in the prompt.
    expect(content).toContain('Get out');
  });

  it('skips characters with fewer than the minimum lines (no AI call for them)', async () => {
    const agent = new CharacterAgentService();
    const aiComplete = makeAiComplete('{"flags":[]}');

    // A chapter where Kai speaks 3 lines but Vane speaks only 1. (Bare lines
    // avoid trailing speech-verb+name patterns that the reverse-tag regex would
    // otherwise mis-attribute away from the turn-taking speaker.)
    const chapter = `
"Get out," Kai said.

"Now."

"Out."

"A single ornate utterance," Professor Vane said.
`;

    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: chapter },
      aiComplete,
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );

    expect(report.charactersReviewed).toEqual(['Kai']);
    expect(aiComplete).toHaveBeenCalledTimes(1);
  });

  it('honors the optional characters filter', async () => {
    const agent = new CharacterAgentService();
    const aiComplete = makeAiComplete('{"flags":[]}');

    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT, characters: ['Professor Vane'] },
      aiComplete,
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );

    expect(report.charactersReviewed).toEqual(['Professor Vane']);
    expect(aiComplete).toHaveBeenCalledTimes(1);
  });

  it('returns empty (no throw, no calls) when there are no character entities', async () => {
    const agent = new CharacterAgentService();
    const aiComplete = makeAiComplete(KAI_FLAGS);
    const onlyLocations: EntityEntry[] = makeEntities().filter((e) => e.type === 'location');

    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT },
      aiComplete,
      makeAiSelect().fn,
      onlyLocations,
      makeSummaries(),
    );

    expect(report.charactersReviewed).toEqual([]);
    expect(report.totalFlags).toBe(0);
    expect(aiComplete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// Robustness — malformed AI output never throws
// ═══════════════════════════════════════════════════════════

describe('CharacterAgentService.critiqueDialogue — graceful degradation', () => {
  it('yields empty flags (no throw) on non-JSON garbage', async () => {
    const agent = new CharacterAgentService();
    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT },
      makeAiComplete('Sorry, everything sounds fine to me!'),
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );
    expect(report.totalFlags).toBe(0);
    // Characters were still "reviewed" — a call was made, it just yielded nothing.
    expect(report.charactersReviewed.length).toBe(2);
    for (const c of report.byCharacter) expect(c.flags).toEqual([]);
  });

  it('strips markdown code fences before parsing', async () => {
    const agent = new CharacterAgentService();
    const fenced = '```json\n' + KAI_FLAGS + '\n```';
    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT, characters: ['Kai'] },
      makeAiComplete(fenced),
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );
    expect(report.totalFlags).toBe(1);
    expect(report.byCharacter[0].flags[0].issue).toBe('off-voice');
  });

  it('recovers a truncated flags array — keeps the complete leading element', async () => {
    const agent = new CharacterAgentService();
    const truncated =
      '{"flags":[' +
      '{"line":"On the contrary","issue":"off-voice","reason":"too ornate","suggestion":"No."},' +
      '{"line":"Furthermore","issue":"off-vo';
    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT, characters: ['Kai'] },
      makeAiComplete(truncated),
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );
    expect(report.totalFlags).toBe(1);
    expect(report.byCharacter[0].flags[0].line).toBe('On the contrary');
  });

  it('drops flags with an invalid issue type or missing line/reason', async () => {
    const agent = new CharacterAgentService();
    const mixed = JSON.stringify({
      flags: [
        { line: 'a', issue: 'nonsense', reason: 'r', suggestion: 's' }, // bad issue → drop
        { line: '', issue: 'off-voice', reason: 'r', suggestion: 's' }, // no line → drop
        { line: 'b', issue: 'off-motivation', reason: '', suggestion: 's' }, // no reason → drop
        { line: 'c', issue: 'anachronistic-knowledge', reason: 'r', suggestion: 's' }, // keep
      ],
    });
    const report = await agent.critiqueDialogue(
      { projectId: 'p', chapterText: CHAPTER_TEXT, characters: ['Kai'] },
      makeAiComplete(mixed),
      makeAiSelect().fn,
      makeEntities(),
      makeSummaries(),
    );
    expect(report.totalFlags).toBe(1);
    expect(report.byCharacter[0].flags[0].issue).toBe('anachronistic-knowledge');
    expect(report.byCharacter[0].flags[0].line).toBe('c');
  });

  it('propagates a provider transport error (so the caller can surface an outage)', async () => {
    const agent = new CharacterAgentService();
    const boom = vi.fn(async () => {
      throw new Error('provider 500');
    });
    await expect(
      agent.critiqueDialogue(
        { projectId: 'p', chapterText: CHAPTER_TEXT, characters: ['Kai'] },
        boom,
        makeAiSelect().fn,
        makeEntities(),
        makeSummaries(),
      ),
    ).rejects.toThrow('provider 500');
  });
});
