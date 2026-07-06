import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEECH_VERBS,
  splitParagraphs,
  startsWithQuote,
  extractSpokenText,
  buildExplicitTagRegex,
  buildReverseTagRegex,
  matchSpeakerTag,
  buildNameLookup,
  escapeRegex,
} from './dialogue-parser.js';

describe('splitParagraphs', () => {
  it('splits on a single blank line', () => {
    const text = 'Para one.\n\nPara two.';
    expect(splitParagraphs(text)).toEqual(['Para one.', 'Para two.']);
  });

  it('splits on multiple blank lines / extra whitespace between', () => {
    const text = 'Para one.\n\n\n   \nPara two.';
    expect(splitParagraphs(text)).toEqual(['Para one.', 'Para two.']);
  });

  it('filters out empty/whitespace-only paragraphs', () => {
    const text = '\n\nPara one.\n\n\n\nPara two.\n\n   \n\n';
    expect(splitParagraphs(text)).toEqual(['Para one.', 'Para two.']);
  });

  it('returns a single-element array for text with no blank lines', () => {
    const text = 'Just one paragraph with no breaks.';
    expect(splitParagraphs(text)).toEqual([text]);
  });

  it('returns an empty array for empty input', () => {
    expect(splitParagraphs('')).toEqual([]);
  });
});

describe('startsWithQuote', () => {
  it('detects a straight double quote', () => {
    expect(startsWithQuote('"Hello," she said.')).toBe(true);
  });

  it('detects a curly opening quote (U+201C)', () => {
    expect(startsWithQuote('“Hello,” she said.')).toBe(true);
  });

  it('detects a curly closing-style quote used as opener (U+201D)', () => {
    expect(startsWithQuote('”Hello.')).toBe(true);
  });

  it('returns false for narration with no leading quote', () => {
    expect(startsWithQuote('She walked to the door.')).toBe(false);
  });

  it('returns false when the quote is not the first character', () => {
    expect(startsWithQuote('She said, "Hello."')).toBe(false);
  });
});

describe('extractSpokenText', () => {
  it('extracts a single quoted segment, stripping the quote marks', () => {
    expect(extractSpokenText('"Hello there," she said.')).toBe('Hello there,');
  });

  it('extracts and joins multiple quoted segments in one paragraph', () => {
    const para = '"Hello," she said. "How are you?"';
    expect(extractSpokenText(para)).toBe('Hello, How are you?');
  });

  it('handles curly quotes', () => {
    const para = '“Hello there,” she said.';
    expect(extractSpokenText(para)).toBe('Hello there,');
  });

  it('returns empty string when there is no quoted text', () => {
    expect(extractSpokenText('She walked to the door.')).toBe('');
  });

  it('a leading empty-quote pair swallows the next quote char, losing the following text', () => {
    // POTENTIAL BUG (documented, not fixed — source is out of scope for this test task):
    // The regex /["“”]([^"“”]+)["“”]/g is greedy/non-overlapping. For input
    // `""  "Real line."` it matches `"  "` as the first pair (quote, two
    // spaces, quote) and consumes the 3rd quote character in the process,
    // leaving `Real line."` with no matching opening quote. Net result: the
    // trimmed capture is blank, gets filtered by `.filter(s => s.length > 0)`,
    // and "Real line." is silently dropped instead of extracted.
    const para = '""  "Real line."';
    expect(extractSpokenText(para)).toBe('');
  });

  it('filters out an empty quoted segment when it is the only segment', () => {
    const para = '""';
    expect(extractSpokenText(para)).toBe('');
  });
});

describe('buildExplicitTagRegex / buildReverseTagRegex / matchSpeakerTag', () => {
  it('matches an explicit tag: quote then Name said', () => {
    const para = '"I refuse," Sarah said.';
    const result = matchSpeakerTag(para);
    expect(result).toEqual({ name: 'Sarah', matchedVia: 'explicit' });
  });

  it('matches an explicit tag with a two-word name', () => {
    const para = '"I refuse," Sarah Connor said.';
    const result = matchSpeakerTag(para);
    expect(result).toEqual({ name: 'Sarah Connor', matchedVia: 'explicit' });
  });

  it('matches an explicit tag using a non-"said" verb from the default list', () => {
    const para = '"Get down!" John shouted.';
    const result = matchSpeakerTag(para);
    expect(result).toEqual({ name: 'John', matchedVia: 'explicit' });
  });

  it('matches a reverse tag: said Name, when no explicit tag is present', () => {
    const para = 'From across the room, said Marcus, unheard by anyone.';
    const result = matchSpeakerTag(para);
    // No quote-adjacent explicit tag exists here, so reverse tag should fire.
    expect(result).toEqual({ name: 'Marcus', matchedVia: 'reverse' });
  });

  it('prefers explicit over reverse when both could plausibly match', () => {
    const para = '"Wait," Alice said. Bob then whispered something back.';
    const result = matchSpeakerTag(para);
    expect(result?.matchedVia).toBe('explicit');
    expect(result?.name).toBe('Alice');
  });

  it('returns null when neither explicit nor reverse tag matches', () => {
    const para = 'The room was silent and empty.';
    expect(matchSpeakerTag(para)).toBeNull();
  });

  it('respects a custom speechVerbs option', () => {
    const para = '"Onward!" Rex declared.';
    // "declared" is not in DEFAULT_SPEECH_VERBS, so default matching should fail...
    expect(matchSpeakerTag(para)).toBeNull();
    // ...but succeed once we pass it as a custom verb.
    const result = matchSpeakerTag(para, { speechVerbs: ['declared'] });
    expect(result).toEqual({ name: 'Rex', matchedVia: 'explicit' });
  });

  it('buildExplicitTagRegex embeds all default speech verbs', () => {
    const re = buildExplicitTagRegex();
    for (const verb of DEFAULT_SPEECH_VERBS) {
      expect(re.source).toContain(verb);
    }
  });

  it('buildReverseTagRegex embeds all default speech verbs', () => {
    const re = buildReverseTagRegex();
    for (const verb of DEFAULT_SPEECH_VERBS) {
      expect(re.source).toContain(verb);
    }
  });
});

describe('buildNameLookup', () => {
  it('maps lowercase names to their canonical form', () => {
    const lookup = buildNameLookup(['Sarah', 'Bob']);
    expect(lookup.get('sarah')).toBe('Sarah');
    expect(lookup.get('bob')).toBe('Bob');
  });

  it('trims whitespace for the lookup KEY but not for the stored canonical VALUE', () => {
    // POTENTIAL BUG (documented, not fixed — source is out of scope for this
    // test task): `buildNameLookup` trims `n` when building the lowercase
    // lookup key (`n.toLowerCase().trim()`) but stores the original,
    // untrimmed `n` as the map value. A name with stray whitespace is
    // therefore still reachable by its trimmed lowercase key, but the
    // canonical name returned to callers retains the whitespace.
    const lookup = buildNameLookup(['  Sarah  ']);
    expect(lookup.get('sarah')).toBe('  Sarah  ');
  });

  it('skips empty names', () => {
    const lookup = buildNameLookup(['', '   ', 'Bob']);
    expect(lookup.size).toBe(1);
    expect(lookup.get('bob')).toBe('Bob');
  });

  it('adds aliases mapped to their canonical name', () => {
    const lookup = buildNameLookup(['Sarah'], { Sarah: ['Sar', 'Sarah Connor'] });
    expect(lookup.get('sar')).toBe('Sarah');
    expect(lookup.get('sarah connor')).toBe('Sarah');
    expect(lookup.get('sarah')).toBe('Sarah');
  });

  it('handles multiple characters with multiple aliases each', () => {
    const lookup = buildNameLookup(
      ['Sarah', 'Bob'],
      { Sarah: ['Sar'], Bob: ['Bobby', 'Robert'] },
    );
    expect(lookup.get('sar')).toBe('Sarah');
    expect(lookup.get('bobby')).toBe('Bob');
    expect(lookup.get('robert')).toBe('Bob');
  });
});

describe('escapeRegex', () => {
  it('escapes regex special characters', () => {
    expect(escapeRegex('a.b*c?d')).toBe('a\\.b\\*c\\?d');
  });

  it('leaves plain alphanumeric text unchanged', () => {
    expect(escapeRegex('plainText123')).toBe('plainText123');
  });

  it('produces a string usable as a literal match in a RegExp', () => {
    const raw = '1 + 1 = 2?';
    const re = new RegExp(escapeRegex(raw));
    expect(re.test(`prefix ${raw} suffix`)).toBe(true);
  });
});
