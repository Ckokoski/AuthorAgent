/**
 * AuthorAgent Beta Reader Service
 *
 * Runs a manuscript (chapter by chapter) through a panel of simulated reader
 * personas and returns structured feedback: tension score, confusion flags,
 * want-to-continue %, favorite moments, stumble points, and aggregate stats.
 *
 * Replaces the former skills/author/beta-reader/SKILL.md prompt-only stub with
 * a real execution service the dashboard / API can drive.
 */

export interface BetaReaderArchetype {
  id: string;
  name: string;
  description: string;          // "Avid fantasy reader, 35, loves worldbuilding"
  preferences: string[];        // What they love
  pet_peeves: string[];         // What they hate
}

export interface ChapterFeedback {
  chapterId: string;
  chapterNumber: number;
  title: string;
  archetypeId: string;
  archetypeName: string;
  tension: number;              // 1-10, engagement per chapter
  pacing: 'too slow' | 'slow' | 'good' | 'fast' | 'too fast';
  wantToContinue: number;       // 0-100, probability reader turns the page
  confusion: string[];          // Specific moments they got lost
  favoriteMoment: string;       // Best scene/line
  stumblePoint: string;         // Where their attention dropped
  emotions: string[];           // ["curiosity", "anxiety", "satisfaction"]
  overallNote: string;          // 1-2 sentence gestalt
}

export interface BetaReaderReport {
  projectId: string;
  generatedAt: string;
  chapterCount: number;
  archetypeCount: number;
  feedback: ChapterFeedback[];
  aggregate: {
    avgTension: number;
    avgWantToContinue: number;
    weakestChapter: { number: number; title: string; reason: string } | null;
    strongestChapter: { number: number; title: string; reason: string } | null;
    topEmotions: string[];
    topConfusions: string[];
  };
}

export type AICompleteFn = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

/**
 * Default archetypes — drop-in panel covering 4 common reader types.
 * Override via constructor parameter or by passing a custom list at scan time.
 */
export const DEFAULT_ARCHETYPES: BetaReaderArchetype[] = [
  {
    id: 'genre-fan',
    name: 'Devoted Genre Fan',
    description: 'Reads 80+ books a year in this genre. Knows every trope. Has strong opinions on execution.',
    preferences: ['clear genre conventions', 'satisfying tropes', 'tight pacing', 'earned payoffs'],
    pet_peeves: ['info dumps', 'flat characters', 'missed tropes', 'meandering openings'],
  },
  {
    id: 'casual-reader',
    name: 'Casual Reader',
    description: 'Reads a book a month, mostly bestsellers. Wants an easy, emotional ride.',
    preferences: ['clear stakes', 'relatable characters', 'short chapters', 'page-turner hooks'],
    pet_peeves: ['complex worldbuilding', 'too many characters', 'unresolved threads', 'slow middles'],
  },
  {
    id: 'literary-critic',
    name: 'Literary Critic',
    description: 'Reads widely across literary and commercial fiction. Notices craft at the sentence level.',
    preferences: ['prose quality', 'thematic depth', 'subtext', 'distinct voice'],
    pet_peeves: ['cliches', 'purple prose', 'on-the-nose dialogue', 'telling vs showing'],
  },
  {
    id: 'target-reader',
    name: 'Target Reader',
    description: 'Fits the exact demographic the author is writing for. The "bullseye" buyer.',
    preferences: ['identification with the protagonist', 'emotional resonance', 'authentic voice', 'wish fulfillment done well'],
    pet_peeves: ['tone mismatch', 'outdated references', 'missed emotional beats', 'wrong POV'],
  },
];

// ═══════════════════════════════════════════════════════════
// Beta Reader Service
// ═══════════════════════════════════════════════════════════

export class BetaReaderService {
  private archetypes: BetaReaderArchetype[];

  constructor(archetypes?: BetaReaderArchetype[]) {
    this.archetypes = archetypes && archetypes.length > 0 ? archetypes : DEFAULT_ARCHETYPES;
  }

  getArchetypes(): BetaReaderArchetype[] {
    return [...this.archetypes];
  }

  /**
   * Parse an AI response into a structured ChapterFeedback.
   * Resilient to minor JSON issues.
   */
  private parseFeedback(
    text: string,
    archetype: BetaReaderArchetype,
    chapter: { id: string; number: number; title: string },
  ): ChapterFeedback {
    let parsed: any = {};
    try {
      // Extract the first JSON object from the response.
      const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      }
    } catch {
      // Fallback: just use the raw text as the overall note.
    }

    const clampTension = (n: any) => Math.max(1, Math.min(10, Number(n) || 5));
    const clampContinue = (n: any) => Math.max(0, Math.min(100, Number(n) || 50));
    const asArray = (v: any) => Array.isArray(v) ? v.map(String) : (v ? [String(v)] : []);
    const validPacing = ['too slow', 'slow', 'good', 'fast', 'too fast'];
    const pacing = validPacing.includes(parsed.pacing) ? parsed.pacing : 'good';

    return {
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      title: chapter.title,
      archetypeId: archetype.id,
      archetypeName: archetype.name,
      tension: clampTension(parsed.tension),
      pacing: pacing as ChapterFeedback['pacing'],
      wantToContinue: clampContinue(parsed.wantToContinue ?? parsed.want_to_continue),
      confusion: asArray(parsed.confusion),
      favoriteMoment: String(parsed.favoriteMoment ?? parsed.favorite_moment ?? ''),
      stumblePoint: String(parsed.stumblePoint ?? parsed.stumble_point ?? ''),
      emotions: asArray(parsed.emotions),
      overallNote: String(parsed.overallNote ?? parsed.overall_note ?? text.substring(0, 300)),
    };
  }

  private buildPrompt(archetype: BetaReaderArchetype): string {
    return `You are roleplaying as a simulated beta reader with this profile:

**Name:** ${archetype.name}
**Profile:** ${archetype.description}
**Loves:** ${archetype.preferences.join(', ')}
**Hates:** ${archetype.pet_peeves.join(', ')}

Read the chapter the user provides and respond with ONLY this JSON structure (no prose, no explanations outside the JSON):

{
  "tension": 1-10 integer (how engaged you are),
  "pacing": "too slow" | "slow" | "good" | "fast" | "too fast",
  "wantToContinue": 0-100 (probability you'd turn the page),
  "confusion": ["specific moment you got confused", "another one"] (may be empty),
  "favoriteMoment": "the single best scene or line, quoted briefly",
  "stumblePoint": "where your attention dropped (may be empty string)",
  "emotions": ["curiosity", "dread", "warmth"] (what you felt),
  "overallNote": "1-2 sentences summarizing your reaction as this reader"
}

Stay in character. React as THIS reader would — not as a critic, not as an editor, not as the author. Be specific about what worked and what didn't.`;
  }

  /**
   * Run the full panel over every provided chapter.
   * The caller supplies chapters (id/number/title/text) and AI callables.
   */
  async scanManuscript(
    projectId: string,
    chapters: Array<{ id: string; number: number; title: string; text: string }>,
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
    archetypes?: BetaReaderArchetype[],
    onProgress?: (msg: string) => void,
  ): Promise<BetaReaderReport> {
    const panel = archetypes && archetypes.length > 0 ? archetypes : this.archetypes;
    const allFeedback: ChapterFeedback[] = [];
    const provider = aiSelectProvider('consistency');

    const total = chapters.length * panel.length;
    let done = 0;

    for (const chapter of chapters) {
      for (const archetype of panel) {
        onProgress?.(`Ch ${chapter.number} / ${archetype.name} (${++done}/${total})`);
        try {
          const response = await aiComplete({
            provider: provider.id,
            system: this.buildPrompt(archetype),
            messages: [
              {
                role: 'user',
                content: `# Chapter ${chapter.number}: ${chapter.title}\n\n${chapter.text}`,
              },
            ],
            maxTokens: 1200,
            temperature: 0.7,
          });
          allFeedback.push(this.parseFeedback(response.text, archetype, chapter));
        } catch (err: any) {
          // Skip — record a neutral entry so the report isn't missing the slot.
          allFeedback.push({
            chapterId: chapter.id,
            chapterNumber: chapter.number,
            title: chapter.title,
            archetypeId: archetype.id,
            archetypeName: archetype.name,
            tension: 5,
            pacing: 'good',
            wantToContinue: 50,
            confusion: [],
            favoriteMoment: '',
            stumblePoint: '',
            emotions: [],
            overallNote: `[AI error: ${err?.message || err}]`,
          });
        }
      }
    }

    const aggregate = this.computeAggregate(allFeedback);

    return {
      projectId,
      generatedAt: new Date().toISOString(),
      chapterCount: chapters.length,
      archetypeCount: panel.length,
      feedback: allFeedback,
      aggregate,
    };
  }

  /** Aggregate stats across all feedback. */
  private computeAggregate(feedback: ChapterFeedback[]): BetaReaderReport['aggregate'] {
    if (feedback.length === 0) {
      return {
        avgTension: 0,
        avgWantToContinue: 0,
        weakestChapter: null,
        strongestChapter: null,
        topEmotions: [],
        topConfusions: [],
      };
    }

    const avgTension = feedback.reduce((sum, f) => sum + f.tension, 0) / feedback.length;
    const avgWantToContinue = feedback.reduce((sum, f) => sum + f.wantToContinue, 0) / feedback.length;

    // Find weakest/strongest chapter by average tension across archetypes.
    const byChapter = new Map<number, { total: number; count: number; title: string }>();
    for (const f of feedback) {
      const existing = byChapter.get(f.chapterNumber);
      if (existing) {
        existing.total += f.tension;
        existing.count += 1;
      } else {
        byChapter.set(f.chapterNumber, { total: f.tension, count: 1, title: f.title });
      }
    }
    const chapterAverages = Array.from(byChapter.entries())
      .map(([number, s]) => ({ number, avg: s.total / s.count, title: s.title }))
      .sort((a, b) => a.avg - b.avg);

    const weakestChapter = chapterAverages[0]
      ? {
          number: chapterAverages[0].number,
          title: chapterAverages[0].title,
          reason: `Average tension ${chapterAverages[0].avg.toFixed(1)}/10 across the panel`,
        }
      : null;
    const strongestChapter = chapterAverages[chapterAverages.length - 1]
      ? {
          number: chapterAverages[chapterAverages.length - 1].number,
          title: chapterAverages[chapterAverages.length - 1].title,
          reason: `Average tension ${chapterAverages[chapterAverages.length - 1].avg.toFixed(1)}/10 across the panel`,
        }
      : null;

    // Count emotions and confusions across all feedback.
    const emotionCounts = new Map<string, number>();
    const confusionCounts = new Map<string, number>();
    for (const f of feedback) {
      for (const e of f.emotions) emotionCounts.set(e.toLowerCase(), (emotionCounts.get(e.toLowerCase()) ?? 0) + 1);
      for (const c of f.confusion) {
        if (c.trim()) {
          const key = c.trim().toLowerCase().substring(0, 80);
          confusionCounts.set(key, (confusionCounts.get(key) ?? 0) + 1);
        }
      }
    }
    const topEmotions = Array.from(emotionCounts.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e]) => e);
    const topConfusions = Array.from(confusionCounts.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);

    return {
      avgTension: Math.round(avgTension * 10) / 10,
      avgWantToContinue: Math.round(avgWantToContinue),
      weakestChapter,
      strongestChapter,
      topEmotions,
      topConfusions,
    };
  }
}
