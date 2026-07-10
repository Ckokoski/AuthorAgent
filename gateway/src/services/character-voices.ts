/**
 * AuthorAgent Per-Character Voice Fingerprinting
 *
 * "Everyone sounds the same" is the most-flagged dialogue critique authors
 * receive. AuthorAgent already has StyleClone for the author's overall voice
 * — this service extends the same 47-marker analyzer to track each NAMED
 * character's dialogue separately.
 *
 * Lifecycle:
 *   1. After each completed writing-phase chapter, extract that chapter's
 *      dialogue, attribute lines to characters (using ContextEngine's
 *      character entity list as the canonical name index), and accumulate
 *      a per-character dialogue corpus.
 *   2. When a character has accumulated >300 words of dialogue, build /
 *      refresh their StyleClone fingerprint.
 *   3. On request (or via writing-judge integration), score new dialogue
 *      from a chapter against each character's fingerprint and surface
 *      "drift" — moments where character X sounds like character Y, or
 *      drifts from their established voice.
 *
 * Cost discipline: dialogue extraction + fingerprinting is local (no AI).
 * Drift scoring is also local. The only AI cost is OPTIONAL — surface
 * specific lines that drifted via a one-line judge call when the user
 * explicitly asks "explain this drift."
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { StyleCloneService, StyleProfile } from './style-clone.js';
import {
  splitParagraphs,
  startsWithQuote,
  extractSpokenText,
  matchSpeakerTag,
  buildNameLookup,
} from './dialogue-parser.js';

/**
 * character-voices.ts's original explicit/reverse tag regexes used a
 * narrower speech-verb list than audiobook-prep.ts's attributeMultiVoice —
 * missing "interjected", "noted", "protested", "objected". Passed explicitly
 * here to preserve this caller's exact original matching behavior (the
 * shared module's default is the union of both lists).
 */
const CHARACTER_VOICES_SPEECH_VERBS = [
  'said', 'asked', 'whispered', 'shouted', 'murmured', 'replied', 'added',
  'continued', 'growled', 'hissed', 'breathed', 'spat', 'snapped', 'laughed',
  'cried', 'exclaimed', 'gasped', 'muttered', 'sighed', 'stammered',
];

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface CharacterVoice {
  characterName: string;
  /** Word count of dialogue accumulated. */
  dialogueWordCount: number;
  /** Most recent fingerprint (rebuilt every ~500 new words). */
  fingerprint: StyleProfile | null;
  /** When the fingerprint was last rebuilt. */
  fingerprintBuiltAt: string | null;
  /** Word-count threshold at which this fingerprint was last built. */
  fingerprintBuiltAtWordCount: number;
  /** Aliases this character has been recognized under (canonical + variants). */
  aliases: string[];
  /** All extracted dialogue, line-by-line. Bounded — keeps the most recent
   *  20K words to limit disk / memory use. */
  dialogueCorpus: string[];
}

export interface DialogueLine {
  /** Raw text of the line (just the spoken portion, quote marks stripped). */
  text: string;
  speaker: string;
  chapterNumber: number;
  /** Confidence the speaker attribution is correct (0-1). */
  attributionConfidence: number;
}

export interface DriftFlag {
  characterName: string;
  chapterNumber: number;
  /** Excerpt of the line(s) that scored as drift. */
  excerpt: string;
  /** Compared metric — short label. */
  marker: string;
  /** This character's expected value. */
  expected: number;
  /** What the new dialogue produced. */
  actual: number;
  /** Std-deviations away from this character's baseline (the drift magnitude). */
  zScore: number;
  /** Author-readable suggestion. */
  note: string;
}

export interface VoiceDriftReport {
  projectId: string;
  chapterNumber: number;
  characters: Array<{
    name: string;
    linesInChapter: number;
    wordsInChapter: number;
    /** Drift summary score 0-100 (higher = more drift). */
    driftScore: number;
    flags: DriftFlag[];
  }>;
  overallDriftScore: number;
  summary: string;
}

interface ProjectStore {
  projectId: string;
  characters: Record<string, CharacterVoice>;
  lastChapterAnalyzed: number;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const FINGERPRINT_REBUILD_THRESHOLD_WORDS = 500;  // rebuild every +500 words
const MIN_WORDS_FOR_FINGERPRINT = 300;            // don't try below this
const CORPUS_CAP_WORDS = 20000;                   // bound per-character storage

export class CharacterVoicesService {
  private storeDir: string;
  private styleClone: StyleCloneService | null = null;
  // Cache loaded project stores so back-to-back chapter completions don't re-read.
  private cache: Map<string, ProjectStore> = new Map();

  constructor(workspaceDir: string) {
    this.storeDir = join(workspaceDir, 'character-voices');
  }

  setStyleClone(styleClone: StyleCloneService): void {
    this.styleClone = styleClone;
  }

  async initialize(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
  }

  // ── Persistence ──

  private storePath(projectId: string): string {
    const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return join(this.storeDir, `${safe}.json`);
  }

  private async load(projectId: string): Promise<ProjectStore> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const path = this.storePath(projectId);
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw) as ProjectStore;
        this.cache.set(projectId, parsed);
        return parsed;
      } catch { /* fall through */ }
    }
    const fresh: ProjectStore = { projectId, characters: {}, lastChapterAnalyzed: 0 };
    this.cache.set(projectId, fresh);
    return fresh;
  }

  private async persist(projectId: string): Promise<void> {
    const store = this.cache.get(projectId);
    if (!store) return;
    try {
      const tmp = this.storePath(projectId) + '.tmp';
      await writeFile(tmp, JSON.stringify(store, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.storePath(projectId));
    } catch (err) {
      console.error('  ✗ Failed to persist character voices:', err);
    }
  }

  // ── Public API ──

  async getProjectVoices(projectId: string): Promise<ProjectStore> {
    return this.load(projectId);
  }

  /**
   * Process a completed chapter — extract dialogue, attribute speakers,
   * accumulate per-character corpora, refresh fingerprints when threshold
   * crossed. Idempotent on (projectId, chapterNumber).
   *
   * The character list comes from ContextEngine (canonical names + aliases).
   * Lines we can't attribute go to the special "narrator" bucket and are
   * skipped for character scoring.
   */
  async ingestChapter(input: {
    projectId: string;
    chapterNumber: number;
    chapterText: string;
    characterNames: string[];           // canonical
    characterAliases?: Record<string, string[]>; // canonical → aliases
  }): Promise<{ linesIngested: number; charactersTouched: string[] }> {
    if (!this.styleClone) {
      throw new Error('StyleClone not wired — call setStyleClone() first');
    }
    const store = await this.load(input.projectId);
    if (input.chapterNumber <= store.lastChapterAnalyzed) {
      // Already processed — re-running won't help. (Could add force-reingest
      // option later; for now idempotency is the right default.)
      return { linesIngested: 0, charactersTouched: [] };
    }

    const lines = this.extractDialogue(
      input.chapterText,
      input.chapterNumber,
      input.characterNames,
      input.characterAliases || {},
    );
    const touched = new Set<string>();
    for (const line of lines) {
      if (line.speaker === 'narrator' || line.attributionConfidence < 0.4) continue;
      const canonicalName = this.canonicalize(line.speaker, input.characterNames, input.characterAliases || {});
      if (!canonicalName) continue;

      let voice = store.characters[canonicalName];
      if (!voice) {
        voice = store.characters[canonicalName] = {
          characterName: canonicalName,
          dialogueWordCount: 0,
          fingerprint: null,
          fingerprintBuiltAt: null,
          fingerprintBuiltAtWordCount: 0,
          aliases: input.characterAliases?.[canonicalName] || [],
          dialogueCorpus: [],
        };
      }
      voice.dialogueCorpus.push(line.text);
      voice.dialogueWordCount += line.text.split(/\s+/).filter(Boolean).length;
      touched.add(canonicalName);

      // Trim corpus if past cap (keep most recent)
      if (voice.dialogueCorpus.length > 100) {
        let total = 0;
        const reversed: string[] = [];
        for (let i = voice.dialogueCorpus.length - 1; i >= 0; i--) {
          const wc = voice.dialogueCorpus[i].split(/\s+/).filter(Boolean).length;
          if (total + wc > CORPUS_CAP_WORDS) break;
          reversed.unshift(voice.dialogueCorpus[i]);
          total += wc;
        }
        voice.dialogueCorpus = reversed;
        voice.dialogueWordCount = total;
      }
    }

    // Refresh fingerprints for any character whose word count crossed a threshold
    for (const name of touched) {
      const voice = store.characters[name];
      if (voice.dialogueWordCount < MIN_WORDS_FOR_FINGERPRINT) continue;
      const wordsSinceLastBuild = voice.dialogueWordCount - voice.fingerprintBuiltAtWordCount;
      if (!voice.fingerprint || wordsSinceLastBuild >= FINGERPRINT_REBUILD_THRESHOLD_WORDS) {
        try {
          const corpus = voice.dialogueCorpus.join('\n');
          voice.fingerprint = this.styleClone.analyze(corpus, `character:${name}`);
          voice.fingerprintBuiltAt = new Date().toISOString();
          voice.fingerprintBuiltAtWordCount = voice.dialogueWordCount;
        } catch (err) {
          // analyze() throws if < 100 words — defensive catch; the threshold
          // check above should prevent this in practice.
        }
      }
    }

    store.lastChapterAnalyzed = Math.max(store.lastChapterAnalyzed, input.chapterNumber);
    await this.persist(input.projectId);
    return { linesIngested: lines.length, charactersTouched: Array.from(touched) };
  }

  /**
   * Score a single chapter for character-voice drift. For each character
   * with a fingerprint, compare their dialogue in this chapter to their
   * historical baseline. Surface lines / metrics that diverge by >2 std-dev.
   *
   * No AI cost — purely statistical comparison against StyleClone markers.
   */
  async detectDrift(input: {
    projectId: string;
    chapterNumber: number;
    chapterText: string;
    characterNames: string[];
    characterAliases?: Record<string, string[]>;
  }): Promise<VoiceDriftReport> {
    if (!this.styleClone) {
      throw new Error('StyleClone not wired');
    }
    const store = await this.load(input.projectId);
    const lines = this.extractDialogue(
      input.chapterText,
      input.chapterNumber,
      input.characterNames,
      input.characterAliases || {},
    );

    // Group lines by canonical character.
    const byCharacter = new Map<string, DialogueLine[]>();
    for (const line of lines) {
      if (line.speaker === 'narrator' || line.attributionConfidence < 0.4) continue;
      const canonical = this.canonicalize(line.speaker, input.characterNames, input.characterAliases || {});
      if (!canonical) continue;
      if (!byCharacter.has(canonical)) byCharacter.set(canonical, []);
      byCharacter.get(canonical)!.push(line);
    }

    const characters: VoiceDriftReport['characters'] = [];
    let overallDriftSum = 0;

    for (const [name, characterLines] of byCharacter) {
      const voice = store.characters[name];
      if (!voice?.fingerprint) {
        // Not enough baseline yet — skip
        characters.push({
          name,
          linesInChapter: characterLines.length,
          wordsInChapter: characterLines.reduce((s, l) => s + l.text.split(/\s+/).filter(Boolean).length, 0),
          driftScore: 0,
          flags: [],
        });
        continue;
      }

      const corpus = characterLines.map(l => l.text).join('\n');
      const wordCount = corpus.split(/\s+/).filter(Boolean).length;
      if (wordCount < 50) {
        // Too little chapter dialogue to trust the comparison
        characters.push({
          name,
          linesInChapter: characterLines.length,
          wordsInChapter: wordCount,
          driftScore: 0,
          flags: [],
        });
        continue;
      }

      let chapterProfile: StyleProfile;
      try {
        chapterProfile = this.styleClone.analyze(corpus, `character:${name}:chapter:${input.chapterNumber}`);
      } catch {
        characters.push({
          name,
          linesInChapter: characterLines.length,
          wordsInChapter: wordCount,
          driftScore: 0,
          flags: [],
        });
        continue;
      }

      // Compare key markers between baseline (voice.fingerprint) and chapter (chapterProfile).
      const flags: DriftFlag[] = [];
      const compareMarkers: Array<{ key: keyof StyleProfile['markers']; label: string; tolerance: number }> = [
        { key: 'avgSentenceLength',     label: 'avg sentence length',     tolerance: 4 },
        { key: 'contractionRate',       label: 'contraction use',         tolerance: 8 },
        { key: 'adverbRate',            label: 'adverb use',              tolerance: 5 },
        { key: 'questionMarkRate',      label: 'question rate',           tolerance: 4 },
        { key: 'exclamationRate',       label: 'exclamation rate',        tolerance: 3 },
        { key: 'hedgingRate',           label: 'hedge-word use',          tolerance: 3 },
        { key: 'intensifierRate',       label: 'intensifier use',         tolerance: 4 },
        { key: 'fragmentRate',          label: 'sentence fragments',      tolerance: 3 },
        { key: 'avgWordLength',         label: 'word length',             tolerance: 0.6 },
      ];

      let driftSum = 0;
      let driftCount = 0;
      for (const m of compareMarkers) {
        const baseline = voice.fingerprint.markers[m.key] as number;
        const actual = chapterProfile.markers[m.key] as number;
        const delta = Math.abs(actual - baseline);
        // Approximate "z-score" using tolerance as the std-dev unit.
        const z = delta / m.tolerance;
        if (z > 2) {
          // Significant drift on this marker
          flags.push({
            characterName: name,
            chapterNumber: input.chapterNumber,
            excerpt: characterLines.slice(0, 1).map(l => `"${l.text.substring(0, 120)}…"`)[0] || '',
            marker: m.label,
            expected: Math.round(baseline * 100) / 100,
            actual: Math.round(actual * 100) / 100,
            zScore: Math.round(z * 10) / 10,
            note: this.buildDriftNote(name, m.label, baseline, actual),
          });
        }
        driftSum += Math.min(z, 4);  // cap individual contribution
        driftCount++;
      }
      const driftScore = driftCount > 0 ? Math.round((driftSum / driftCount) * 25) : 0;
      overallDriftSum += driftScore;

      characters.push({
        name,
        linesInChapter: characterLines.length,
        wordsInChapter: wordCount,
        driftScore: Math.min(100, driftScore),
        flags,
      });
    }

    const overallDriftScore = characters.length > 0
      ? Math.round(overallDriftSum / characters.length)
      : 0;

    const flagsTotal = characters.reduce((s, c) => s + c.flags.length, 0);
    const summary = flagsTotal === 0
      ? `No significant voice drift in chapter ${input.chapterNumber}. ${characters.length} character${characters.length === 1 ? '' : 's'} checked.`
      : `Chapter ${input.chapterNumber}: ${flagsTotal} drift flag${flagsTotal === 1 ? '' : 's'} across ${characters.filter(c => c.flags.length > 0).length} character${characters.filter(c => c.flags.length > 0).length === 1 ? '' : 's'}.`;

    return {
      projectId: input.projectId,
      chapterNumber: input.chapterNumber,
      characters,
      overallDriftScore,
      summary,
    };
  }

  // ── Internal helpers ──

  /**
   * Pull dialogue lines from a chapter and attribute speakers using the
   * standard quote conventions + optional dialogue tags. Same heuristic as
   * the audiobook attribution pipeline; we share the regex patterns.
   */
  private extractDialogue(
    chapterText: string,
    chapterNumber: number,
    characterNames: string[],
    aliases: Record<string, string[]>,
  ): DialogueLine[] {
    const lines: DialogueLine[] = [];
    const charNameLower = buildNameLookup(characterNames, aliases);

    // Split on paragraph boundaries.
    const paragraphs = splitParagraphs(chapterText);
    let lastSpeaker: string | null = null;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!startsWithQuote(trimmed)) {
        // Pure narration — skip
        continue;
      }

      // Extract just the spoken portion(s) — text inside quotes
      const spoken = extractSpokenText(trimmed);
      if (!spoken) continue;

      let speakerName: string | null = null;
      let confidence = 0;

      // Try explicit tag first, then reverse tag.
      const tagMatch = matchSpeakerTag(trimmed, { speechVerbs: CHARACTER_VOICES_SPEECH_VERBS });
      if (tagMatch) {
        speakerName = tagMatch.name;
        confidence = tagMatch.matchedVia === 'explicit' ? 0.9 : 0.85;
      }

      // Validate against known character list
      if (speakerName) {
        const canonical = charNameLower.get(speakerName.toLowerCase());
        if (canonical) {
          speakerName = canonical;
          lastSpeaker = canonical;
        } else {
          // Unknown name — could be minor character or false-positive. Skip.
          confidence = 0.3;
        }
      } else if (lastSpeaker) {
        // Bare dialogue — turn-taking heuristic
        speakerName = lastSpeaker;
        confidence = 0.5;
      }

      if (speakerName) {
        lines.push({
          text: spoken,
          speaker: speakerName,
          chapterNumber,
          attributionConfidence: confidence,
        });
      }
    }

    return lines;
  }

  private canonicalize(
    name: string,
    characterNames: string[],
    aliases: Record<string, string[]>,
  ): string | null {
    return buildNameLookup(characterNames, aliases).get(name.toLowerCase()) ?? null;
  }

  private buildDriftNote(name: string, marker: string, expected: number, actual: number): string {
    const direction = actual > expected ? 'higher than usual' : 'lower than usual';
    return `${name}'s ${marker} in this chapter is ${direction} (expected ~${expected.toFixed(1)}, got ${actual.toFixed(1)}). ` +
      `Either ${name} is genuinely changing voice for a reason (intentional — ignore), or this dialogue may be ` +
      `bleeding into another character's voice. Worth a re-read of their lines in this chapter.`;
  }
}
