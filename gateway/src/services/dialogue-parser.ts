/**
 * AuthorClaw Shared Dialogue Parser
 *
 * Pure, stateless dialogue-extraction / speaker-attribution helpers shared by
 * character-voices.ts (per-character StyleClone fingerprinting) and
 * audiobook-prep.ts (multi-voice audiobook segment attribution).
 *
 * Both services independently grew near-identical regex logic for:
 *   - splitting a chapter into paragraphs
 *   - detecting whether a paragraph opens with a quote (i.e. is dialogue)
 *   - pulling the quoted spoken text out of a paragraph
 *   - guessing the speaker from an attribution tag ("...," Name said. / said Name.)
 *
 * This module centralizes that logic. Callers keep their own orchestration,
 * confidence/inferred semantics, and output shapes — only the low-level
 * regex/extraction primitives are shared.
 */

/** Verb list used in dialogue attribution tags. Union of both callers'
 *  original verb lists — audiobook-prep's `attributeMultiVoice` included
 *  a few extra verbs (interjected, noted, protested, objected) that
 *  character-voices.ts's `extractDialogue` lacked. Keeping the union as
 *  the shared default is strictly more permissive and doesn't change
 *  either caller's positive matches; see `speechVerbs` option to override.
 */
export const DEFAULT_SPEECH_VERBS = [
  'said', 'asked', 'whispered', 'shouted', 'murmured', 'replied', 'added',
  'continued', 'growled', 'hissed', 'breathed', 'spat', 'snapped', 'laughed',
  'cried', 'exclaimed', 'gasped', 'muttered', 'sighed', 'stammered',
  'interjected', 'noted', 'protested', 'objected',
];

export interface SpeakerTagOptions {
  /** Speech verbs to recognize in attribution tags. Defaults to the shared
   *  union list (DEFAULT_SPEECH_VERBS). */
  speechVerbs?: string[];
}

/** Split chapter text into non-empty paragraphs on blank-line boundaries.
 *  Identical in both original callers: `/\n\s*\n+/`. */
export function splitParagraphs(chapterText: string): string[] {
  return chapterText.split(/\n\s*\n+/).filter(p => p.trim());
}

/** True if a (trimmed) paragraph opens with a quote character, i.e. is
 *  likely a dialogue paragraph rather than pure narration. Covers straight
 *  and curly opening quotes (both originals used slightly different
 *  character sets here — the union covers `"` `"` `"`). */
export function startsWithQuote(trimmedParagraph: string): boolean {
  return /^["“”]/.test(trimmedParagraph);
}

/** Extract and join the spoken (quoted) portion(s) of a paragraph, stripping
 *  quote marks. Returns '' if no quoted text is found. */
export function extractSpokenText(trimmedParagraph: string): string {
  // Require at least one non-space, non-quote char between the quotes. Straight
  // quotes are ambiguous (the same char opens and closes), so a whitespace-only
  // pair like `"  "` would otherwise match first and consume the opening quote
  // of the *next* real line, silently dropping it.
  const spokenMatches = trimmedParagraph.match(/["“”][^"“”]*[^\s"“”][^"“”]*["“”]/g) || [];
  return spokenMatches
    .map(m => m.replace(/^["“”]/, '').replace(/["“”]$/, '').trim())
    .filter(s => s.length > 0)
    .join(' ');
}

/** Build the explicit-tag regex: `"..." Name said.` style — name precedes verb.
 *  Matches immediately after a closing quote + optional punctuation. */
export function buildExplicitTagRegex(options: SpeakerTagOptions = {}): RegExp {
  const verbs = (options.speechVerbs || DEFAULT_SPEECH_VERBS).join('|');
  return new RegExp(
    `["”“]\\s*[,.?!]?\\s*([A-Z][a-z]{2,}(?:\\s+[A-Z][a-z]+)?)\\s+(?:${verbs})\\b`,
    'i',
  );
}

/** Build the reverse-tag regex: `said Name` style — verb precedes name. */
export function buildReverseTagRegex(options: SpeakerTagOptions = {}): RegExp {
  const verbs = (options.speechVerbs || DEFAULT_SPEECH_VERBS).join('|');
  return new RegExp(
    `\\b(?:${verbs})\\s+([A-Z][a-z]{2,}(?:\\s+[A-Z][a-z]+)?)`,
    'i',
  );
}

/**
 * Attempt to extract a speaker name from a dialogue paragraph using explicit
 * then reverse attribution-tag matching. Returns null if neither matches.
 */
export function matchSpeakerTag(
  trimmedParagraph: string,
  options: SpeakerTagOptions = {},
): { name: string; matchedVia: 'explicit' | 'reverse' } | null {
  const explicitRe = buildExplicitTagRegex(options);
  const explicit = trimmedParagraph.match(explicitRe);
  if (explicit?.[1]) {
    return { name: explicit[1].trim(), matchedVia: 'explicit' };
  }
  const reverseRe = buildReverseTagRegex(options);
  const reverse = trimmedParagraph.match(reverseRe);
  if (reverse?.[1]) {
    return { name: reverse[1].trim(), matchedVia: 'reverse' };
  }
  return null;
}

/** Build a lowercase-name → canonical-name lookup map from a character list
 *  plus an optional canonical→aliases map. Shared by both callers. */
export function buildNameLookup(
  characterNames: string[],
  aliases: Record<string, string[]> = {},
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const n of characterNames) {
    const canon = n.trim();
    const k = canon.toLowerCase();
    if (k) lookup.set(k, canon);
  }
  for (const [canon, aliasList] of Object.entries(aliases)) {
    const canonTrimmed = canon.trim();
    for (const a of aliasList) lookup.set(a.toLowerCase().trim(), canonTrimmed);
  }
  return lookup;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
