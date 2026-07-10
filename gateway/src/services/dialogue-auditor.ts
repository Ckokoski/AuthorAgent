/**
 * AuthorAgent Dialogue Auditor
 *
 * Extracts every dialogue line from a manuscript, attributes each to a
 * speaker (when possible), builds per-character voice fingerprints, and
 * flags lines that don't match the attributed speaker's profile.
 *
 * Heuristic-first (no AI): fast, deterministic, works offline. The optional
 * AI layer can be called by the caller for higher-accuracy attribution.
 */

export interface DialogueLine {
  chapterId?: string;
  paragraphIndex: number;
  text: string;               // Just the spoken words, without quotes
  fullLine: string;           // Original paragraph verbatim
  speaker: string | null;     // Attributed character, null if unknown
  tag: string | null;         // "said Alice", "asked", etc.
  tagVerb: string | null;     // 'said', 'asked', 'whispered'…
}

export interface VoiceFingerprint {
  speaker: string;
  lineCount: number;
  wordCount: number;
  avgSentenceLength: number;
  contractionRate: number;    // contractions / total-words (0-1)
  formalityScore: number;     // 0 (informal) – 1 (formal)
  questionRate: number;       // questions / total lines
  exclamationRate: number;
  avgLineLength: number;
  signaturePhrases: string[]; // 3-word phrases used 3+ times by this speaker and nobody else
  commonStarts: string[];     // Top 5 opening 2-grams
}

export interface DialogueFlag {
  chapterId?: string;
  paragraphIndex: number;
  speaker: string;
  line: string;
  reason: string;
  severity: 'info' | 'warning' | 'error';
}

export interface DialogueReport {
  totalLines: number;
  attributed: number;
  unattributed: number;
  fingerprints: VoiceFingerprint[];
  flags: DialogueFlag[];
}

// Common dialogue-tag verbs.
const TAG_VERBS = new Set([
  'said', 'asked', 'replied', 'whispered', 'shouted', 'muttered', 'murmured',
  'yelled', 'cried', 'laughed', 'snapped', 'growled', 'hissed', 'sighed',
  'breathed', 'added', 'continued', 'explained', 'noted', 'remarked',
  'stated', 'answered', 'responded', 'called', 'demanded', 'insisted',
  'countered', 'observed', 'declared', 'announced', 'scolded', 'grumbled',
  'mumbled', 'protested', 'retorted', 'agreed', 'confessed', 'admitted',
]);

// Common English contractions — used for contraction-rate feature.
const CONTRACTION_RE = /\b(?:I'm|I've|I'll|I'd|you're|you've|you'll|you'd|he's|he'll|he'd|she's|she'll|she'd|it's|it'll|it'd|we're|we've|we'll|we'd|they're|they've|they'll|they'd|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|mustn't|shan't|y'all)\b/gi;

// Low-formality markers (contractions, "gonna", "gotta", "yeah", "nah"…)
const INFORMAL_MARKERS = /\b(?:gonna|gotta|wanna|lemme|yeah|nah|nope|yep|dunno|kinda|sorta|cuz|coz|hey|hiya|y'know|buddy|pal|dude|man|bro|sis)\b/gi;

// High-formality markers ("shall", "indeed", "furthermore"…)
const FORMAL_MARKERS = /\b(?:shall|indeed|furthermore|moreover|nevertheless|regarding|hence|thus|therefore|accordingly|pursuant|herein|whilst|perhaps|quite|rather|somewhat|apparently|presumably)\b/gi;

export class DialogueAuditor {
  /**
   * Extract dialogue from a block of prose. Heuristic: any paragraph
   * starting with a straight/curly double quote is dialogue. The speaker
   * is attributed from the tag verb (e.g., "said Alice") when present.
   */
  extractLines(text: string, chapterId?: string): DialogueLine[] {
    const paragraphs = text.split(/\n\s*\n/);
    const lines: DialogueLine[] = [];

    paragraphs.forEach((para, idx) => {
      const trimmed = para.trim();
      if (!trimmed) return;
      // Must start with a quote (ASCII or typographic).
      if (!/^["\u201C\u201D]/.test(trimmed)) return;

      const { dialogueText, tag, tagVerb, speaker } = this.parseDialogueParagraph(trimmed);
      if (!dialogueText) return;

      lines.push({
        chapterId,
        paragraphIndex: idx,
        text: dialogueText,
        fullLine: trimmed,
        speaker,
        tag,
        tagVerb,
      });
    });

    return lines;
  }

  /** Parse one paragraph into its dialogue core, tag, and inferred speaker. */
  private parseDialogueParagraph(paragraph: string): {
    dialogueText: string;
    tag: string | null;
    tagVerb: string | null;
    speaker: string | null;
  } {
    // Match opening quote through closing quote (handles curly and straight).
    const quoteRe = /^["\u201C]([^"\u201D]*)["\u201D](.*)$/s;
    const m = paragraph.match(quoteRe);
    if (!m) return { dialogueText: '', tag: null, tagVerb: null, speaker: null };

    const dialogueText = m[1].trim();
    const remainder = m[2].trim().replace(/^[.,!?;—-]+/, '').trim();

    if (!remainder) {
      return { dialogueText, tag: null, tagVerb: null, speaker: null };
    }

    // Look for a tag verb in the remainder.
    const words = remainder.split(/\s+/);
    let tagVerb: string | null = null;
    let verbIdx = -1;
    for (let i = 0; i < Math.min(words.length, 6); i++) {
      const lower = words[i].toLowerCase().replace(/[^a-z]/g, '');
      if (TAG_VERBS.has(lower)) {
        tagVerb = lower;
        verbIdx = i;
        break;
      }
    }

    if (!tagVerb) {
      return { dialogueText, tag: remainder, tagVerb: null, speaker: null };
    }

    // Speaker is typically the next noun after the verb (e.g., "said Alice"),
    // OR the subject before the verb (e.g., "Alice said").
    let speaker: string | null = null;
    if (verbIdx > 0) {
      // Subject-before-verb pattern — take up to 3 words before the verb.
      const before = words.slice(Math.max(0, verbIdx - 3), verbIdx).join(' ').replace(/[,;.]/g, '').trim();
      speaker = this.extractProperNoun(before);
    }
    if (!speaker && verbIdx < words.length - 1) {
      // Verb-first pattern — take the next word (or pronoun-phrase).
      const after = words.slice(verbIdx + 1, Math.min(verbIdx + 4, words.length)).join(' ').replace(/[,;.]/g, '').trim();
      speaker = this.extractProperNoun(after);
    }

    return { dialogueText, tag: remainder, tagVerb, speaker };
  }

  /** Pull the first capitalized word (simple proper-noun heuristic). */
  private extractProperNoun(text: string): string | null {
    const m = text.match(/([A-Z][a-zA-Z'-]{1,30})(?:\s+[A-Z][a-zA-Z'-]{1,30})?/);
    if (!m) return null;
    // Skip pronouns mistaken as names.
    const w = m[0];
    if (/^(He|She|They|It|I|We|You)\b/.test(w)) return null;
    return w;
  }

  /**
   * Build per-character voice fingerprints from a set of extracted lines.
   * Requires at least 3 lines per character to produce a fingerprint.
   */
  buildFingerprints(lines: DialogueLine[]): VoiceFingerprint[] {
    const grouped = new Map<string, DialogueLine[]>();
    for (const line of lines) {
      if (!line.speaker) continue;
      const existing = grouped.get(line.speaker);
      if (existing) existing.push(line);
      else grouped.set(line.speaker, [line]);
    }

    const all3grams = new Map<string, Map<string, number>>(); // phrase → speaker → count

    const fingerprints: VoiceFingerprint[] = [];
    for (const [speaker, speakerLines] of grouped) {
      if (speakerLines.length < 3) continue;

      const allText = speakerLines.map(l => l.text).join(' ');
      const words = allText.split(/\s+/).filter(Boolean);
      const sentences = allText.split(/[.!?]+/).filter(s => s.trim().length > 0);

      const contractionMatches = allText.match(CONTRACTION_RE);
      const contractionCount = contractionMatches ? contractionMatches.length : 0;
      const informalMatches = allText.match(INFORMAL_MARKERS);
      const formalMatches = allText.match(FORMAL_MARKERS);
      const informalScore = (informalMatches?.length ?? 0) / Math.max(1, words.length) * 100;
      const formalScore = (formalMatches?.length ?? 0) / Math.max(1, words.length) * 100;

      // Formality 0-1: formal wins → higher, informal wins → lower, mixed → 0.5
      let formality = 0.5;
      const delta = formalScore - informalScore;
      if (delta > 0.5) formality = Math.min(1, 0.5 + delta / 10);
      else if (delta < -0.5) formality = Math.max(0, 0.5 + delta / 10);

      const questionCount = speakerLines.filter(l => l.text.trim().endsWith('?')).length;
      const exclamationCount = speakerLines.filter(l => l.text.trim().endsWith('!')).length;

      // Collect 3-grams for signature-phrase detection.
      const my3grams = new Map<string, number>();
      for (let i = 0; i < words.length - 2; i++) {
        const phrase = words.slice(i, i + 3).join(' ').toLowerCase().replace(/[^a-z' ]/g, '');
        if (phrase.split(' ').length < 3) continue;
        my3grams.set(phrase, (my3grams.get(phrase) ?? 0) + 1);
        const crossCount = all3grams.get(phrase) ?? new Map<string, number>();
        crossCount.set(speaker, (crossCount.get(speaker) ?? 0) + 1);
        all3grams.set(phrase, crossCount);
      }

      // Common 2-gram starts.
      const startCounts = new Map<string, number>();
      for (const l of speakerLines) {
        const firstTwo = l.text.split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/[^a-z' ]/g, '');
        if (firstTwo) startCounts.set(firstTwo, (startCounts.get(firstTwo) ?? 0) + 1);
      }
      const commonStarts = Array.from(startCounts.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);

      fingerprints.push({
        speaker,
        lineCount: speakerLines.length,
        wordCount: words.length,
        avgSentenceLength: sentences.length > 0 ? Math.round((words.length / sentences.length) * 10) / 10 : 0,
        contractionRate: Math.round((contractionCount / Math.max(1, words.length)) * 1000) / 1000,
        formalityScore: Math.round(formality * 100) / 100,
        questionRate: Math.round((questionCount / speakerLines.length) * 100) / 100,
        exclamationRate: Math.round((exclamationCount / speakerLines.length) * 100) / 100,
        avgLineLength: Math.round(words.length / speakerLines.length),
        signaturePhrases: [],
        commonStarts,
      });
    }

    // Compute signature phrases: 3-grams used 3+ times by exactly one speaker.
    for (const [phrase, speakerCounts] of all3grams) {
      const totalUsers = Array.from(speakerCounts.keys()).length;
      if (totalUsers !== 1) continue;
      const [sp, cnt] = Array.from(speakerCounts.entries())[0];
      if (cnt < 3) continue;
      const fp = fingerprints.find(f => f.speaker === sp);
      if (fp && fp.signaturePhrases.length < 8) fp.signaturePhrases.push(phrase);
    }

    return fingerprints;
  }

  /**
   * Flag lines that don't match the attributed speaker's fingerprint.
   * Looks at: formality delta, contraction delta, line-length delta.
   */
  flagMismatches(lines: DialogueLine[], fingerprints: VoiceFingerprint[]): DialogueFlag[] {
    const fpMap = new Map(fingerprints.map(f => [f.speaker, f]));
    const flags: DialogueFlag[] = [];

    for (const line of lines) {
      if (!line.speaker) continue;
      const fp = fpMap.get(line.speaker);
      if (!fp || fp.lineCount < 5) continue; // Need enough data.

      const words = line.text.split(/\s+/).filter(Boolean);
      if (words.length < 4) continue; // Skip very short lines.

      const contractionsHere = (line.text.match(CONTRACTION_RE) ?? []).length;
      const lineContractionRate = contractionsHere / Math.max(1, words.length);

      // Flag if contraction rate differs by more than 0.15 from the speaker's baseline.
      if (Math.abs(lineContractionRate - fp.contractionRate) > 0.15) {
        flags.push({
          chapterId: line.chapterId,
          paragraphIndex: line.paragraphIndex,
          speaker: line.speaker,
          line: line.text,
          reason: lineContractionRate > fp.contractionRate
            ? `${line.speaker} is unusually casual here (contractions ${(lineContractionRate * 100).toFixed(0)}% vs their baseline ${(fp.contractionRate * 100).toFixed(0)}%)`
            : `${line.speaker} is unusually formal here (no contractions despite their baseline ${(fp.contractionRate * 100).toFixed(0)}%)`,
          severity: 'warning',
        });
        continue;
      }

      // Flag sharp line-length deltas (2x longer or shorter than baseline).
      if (fp.avgLineLength > 0) {
        const ratio = words.length / fp.avgLineLength;
        if (ratio > 2.5 || ratio < 0.3) {
          flags.push({
            chapterId: line.chapterId,
            paragraphIndex: line.paragraphIndex,
            speaker: line.speaker,
            line: line.text,
            reason: `${line.speaker}'s line is ${ratio > 1 ? 'much longer' : 'much shorter'} than usual (${words.length} words vs ${fp.avgLineLength} avg)`,
            severity: 'info',
          });
        }
      }
    }

    return flags;
  }

  /** End-to-end: extract → fingerprint → flag. */
  audit(text: string, chapterId?: string): DialogueReport {
    const lines = this.extractLines(text, chapterId);
    const fingerprints = this.buildFingerprints(lines);
    const flags = this.flagMismatches(lines, fingerprints);
    const attributed = lines.filter(l => l.speaker).length;
    return {
      totalLines: lines.length,
      attributed,
      unattributed: lines.length - attributed,
      fingerprints,
      flags,
    };
  }
}
