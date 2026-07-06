import { describe, it, expect } from 'vitest';
import { PRICING, PRICING_LAST_VERIFIED, getOpenAIImagePrice } from './pricing.js';

describe('PRICING table shape', () => {
  it('exposes lastVerified matching the exported constant', () => {
    expect(PRICING.lastVerified).toBe(PRICING_LAST_VERIFIED);
    expect(typeof PRICING_LAST_VERIFIED).toBe('string');
    expect(PRICING_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has openai image pricing for all three documented sizes', () => {
    expect(PRICING.image.openai['1024x1024'].usd).toBe(0.17);
    expect(PRICING.image.openai['1024x1536'].usd).toBe(0.25);
    expect(PRICING.image.openai['1536x1024'].usd).toBe(0.25);
  });

  it('marks openai gpt-image-1 pricing as "listed" confidence', () => {
    expect(PRICING.image.openai['1024x1024'].confidence).toBe('listed');
    expect(PRICING.image.openai['1024x1536'].confidence).toBe('listed');
    expect(PRICING.image.openai['1536x1024'].confidence).toBe('listed');
  });

  it('has a quality multiplier table with all four quality levels for openai', () => {
    expect(PRICING.image.openai.qualityMultiplier).toEqual({
      low: 0.25,
      medium: 0.5,
      high: 1.0,
      auto: 1.0,
    });
  });

  it('mirrors gpt-image-1 figures for the gpt-image-2 placeholder table, marked "rough"', () => {
    const g1 = PRICING.image.openai;
    const g2 = PRICING.image['openai-gpt-image-2'];
    expect(g2['1024x1024'].usd).toBe(g1['1024x1024'].usd);
    expect(g2['1024x1536'].usd).toBe(g1['1024x1536'].usd);
    expect(g2['1536x1024'].usd).toBe(g1['1536x1024'].usd);
    expect(g2['1024x1024'].confidence).toBe('rough');
    expect(g2['1024x1536'].confidence).toBe('rough');
    expect(g2['1536x1024'].confidence).toBe('rough');
  });

  it('has gemini and together pricing entries', () => {
    expect(PRICING.image.gemini.default.usd).toBeCloseTo(0.039, 5);
    expect(PRICING.image.together.free.usd).toBe(0);
    expect(PRICING.image.together.pro.usd).toBe(0.04);
  });

  it('has a launchSteps table with a default fallback entry', () => {
    expect(PRICING.launchSteps.default).toBeDefined();
    expect(PRICING.launchSteps.default.usd).toBe(0);
    expect(PRICING.launchSteps.default.confidence).toBe('rough');
  });

  it('has launchSteps entries for known platforms with the documented confidence levels', () => {
    expect(PRICING.launchSteps.ams.usd).toBe(0);
    expect(PRICING.launchSteps.kdp.confidence).toBe('listed');
    expect(PRICING.launchSteps.internal.confidence).toBe('listed');
    expect(PRICING.launchSteps.bookbub.confidence).toBe('rough');
    expect(PRICING.launchSteps.social.confidence).toBe('rough');
  });

  it('every PriceEntry has a non-empty human-readable note', () => {
    const allEntries: any[] = [
      ...Object.values(PRICING.image.openai).filter((v: any) => v && typeof v === 'object' && 'usd' in v),
      ...Object.values(PRICING.image['openai-gpt-image-2']).filter((v: any) => v && typeof v === 'object' && 'usd' in v),
      PRICING.image.gemini.default,
      PRICING.image.together.free,
      PRICING.image.together.pro,
      ...Object.values(PRICING.launchSteps),
    ];
    for (const entry of allEntries) {
      expect(typeof entry.note).toBe('string');
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});

describe('getOpenAIImagePrice — gpt-image-1 (default model)', () => {
  it('returns the high-quality base price for 1024x1024', () => {
    expect(getOpenAIImagePrice(1024, 1024)).toBe(0.17);
  });

  it('returns the high-quality base price for the portrait book-cover size', () => {
    expect(getOpenAIImagePrice(1024, 1536)).toBe(0.25);
  });

  it('returns the high-quality base price for the landscape size', () => {
    expect(getOpenAIImagePrice(1536, 1024)).toBe(0.25);
  });

  it('applies the low quality multiplier (0.25x)', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'low')).toBe(0.04); // 0.17 * 0.25 = 0.0425 -> rounds to 0.04
  });

  it('applies the medium quality multiplier (0.5x)', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'medium')).toBe(0.09); // 0.17 * 0.5 = 0.085 -> rounds to 0.09 (banker's round via Math.round)
  });

  it('applies the auto quality multiplier (treated as 1.0x, same as high)', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'auto')).toBe(0.17);
  });

  it('defaults to high quality when no quality argument is given', () => {
    expect(getOpenAIImagePrice(1024, 1536)).toBe(getOpenAIImagePrice(1024, 1536, 'high'));
  });

  it('falls back to the 1024x1536 price for an unrecognized size', () => {
    expect(getOpenAIImagePrice(9999, 9999)).toBe(0.25);
  });

  it('rounds to the nearest cent', () => {
    const price = getOpenAIImagePrice(1024, 1536, 'medium'); // 0.25 * 0.5 = 0.125
    expect(price).toBe(0.13); // Math.round(12.5) = 13 (round-half-up in JS for positive numbers)
  });
});

describe('getOpenAIImagePrice — gpt-image-2 (explicit model)', () => {
  it('uses the gpt-image-2 placeholder table when model === "gpt-image-2"', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'high', 'gpt-image-2')).toBe(0.17);
    expect(getOpenAIImagePrice(1024, 1536, 'high', 'gpt-image-2')).toBe(0.25);
  });

  it('applies quality multipliers the same way as gpt-image-1', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'low', 'gpt-image-2')).toBe(0.04);
  });

  it('falls back to 1024x1536 for unrecognized sizes on gpt-image-2 as well', () => {
    expect(getOpenAIImagePrice(1, 1, 'high', 'gpt-image-2')).toBe(0.25);
  });

  it('uses gpt-image-1 pricing for any model string other than "gpt-image-2"', () => {
    expect(getOpenAIImagePrice(1024, 1024, 'high', 'some-other-model')).toBe(0.17);
    expect(getOpenAIImagePrice(1024, 1024, 'high', undefined)).toBe(0.17);
  });
});

describe('launch-step lookup (PRICING.launchSteps as a direct map)', () => {
  const knownSteps = ['ams', 'bookfunnel', 'esp', 'bookbub', 'kdp', 'social', 'internal', 'default'];

  it.each(knownSteps)('has an entry for launch step "%s"', (step) => {
    expect(PRICING.launchSteps[step]).toBeDefined();
    expect(typeof PRICING.launchSteps[step].usd).toBe('number');
  });

  it('returns undefined for an unknown step key (callers must fall back to .default themselves)', () => {
    expect(PRICING.launchSteps['totally-unknown-step']).toBeUndefined();
  });
});
