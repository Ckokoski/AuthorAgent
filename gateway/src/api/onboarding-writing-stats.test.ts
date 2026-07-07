/**
 * Tests for the Phase 5 onboarding + writing-stats backend support:
 *   - Pure detection helpers used by GET /api/onboarding/status
 *     (gateway/src/api/context.ts: hasProviderKeyName, isVoiceProfileTemplate)
 *   - WritingStatsStore + computeStreaks used by GET /api/writing/stats
 *     (gateway/src/services/writing-stats.ts)
 *
 * These test the exact logic the routes call, without spinning up Express —
 * matching the existing codebase convention of unit-testing service/helper
 * classes directly with tmp directories (see preferences.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { hasProviderKeyName, isVoiceProfileTemplate } from './context.js';
import { WritingStatsStore, computeStreaks } from '../services/writing-stats.js';

// ═══════════════════════════════════════════════════════════
// hasProviderKeyName
// ═══════════════════════════════════════════════════════════

describe('hasProviderKeyName', () => {
  it('returns false for an empty key list', () => {
    expect(hasProviderKeyName([])).toBe(false);
  });

  it('returns false when only non-provider keys are present', () => {
    expect(hasProviderKeyName(['telegram_bot_token'])).toBe(false);
  });

  it('returns true when gemini_api_key is present (matches the task scenario: gemini present, openai/anthropic missing)', () => {
    expect(hasProviderKeyName(['gemini_api_key', 'telegram_bot_token'])).toBe(true);
  });

  it('returns true for each known provider key individually', () => {
    const providers = [
      'gemini_api_key', 'deepseek_api_key', 'anthropic_api_key',
      'openai_api_key', 'openrouter_api_key', 'together_api_key',
    ];
    for (const key of providers) {
      expect(hasProviderKeyName([key])).toBe(true);
    }
  });

  it('is not fooled by substring matches', () => {
    expect(hasProviderKeyName(['not_a_gemini_api_key_really', 'openai_api_key_backup'])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// isVoiceProfileTemplate
// ═══════════════════════════════════════════════════════════

describe('isVoiceProfileTemplate', () => {
  it('treats empty content as template (not analyzed)', () => {
    expect(isVoiceProfileTemplate('')).toBe(true);
    expect(isVoiceProfileTemplate('   \n  ')).toBe(true);
  });

  it('detects the shipped template marker', () => {
    const template = `# Voice Profile\n\n## Status: Not Yet Analyzed\n\nSend a sample...`;
    expect(isVoiceProfileTemplate(template)).toBe(true);
  });

  it('detects the real, current VOICE-PROFILE.template.md shipped in the repo', () => {
    // Guards against future edits to the template accidentally dropping the
    // marker line this detector relies on.
    const path = join(process.cwd(), 'workspace', 'soul', 'VOICE-PROFILE.template.md');
    if (!existsSync(path)) return; // repo layout changed — skip rather than false-fail
    const content = readFileSync(path, 'utf-8');
    expect(isVoiceProfileTemplate(content)).toBe(true);
  });

  it('returns false once real analysis has replaced the template', () => {
    const analyzed = `# Voice Profile\n\n## Sentence Patterns\nAverage length: 14 words...\n\n## Vocabulary Level\nComplex, literary...`;
    expect(isVoiceProfileTemplate(analyzed)).toBe(false);
  });

  it('returns false for analyzed content that happens to mention "not yet" elsewhere', () => {
    const analyzed = `# Voice Profile\n\nThis author has not yet used semicolons in any sample, interestingly.\n\n## Sentence Patterns\n...`;
    expect(isVoiceProfileTemplate(analyzed)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// computeStreaks (pure function, no filesystem)
// ═══════════════════════════════════════════════════════════

describe('computeStreaks', () => {
  const NOW = new Date('2026-07-07T12:00:00.000Z'); // matches "today" in the task's date context

  it('returns 0/0 for no recorded days', () => {
    expect(computeStreaks({}, NOW)).toEqual({ currentStreakDays: 0, longestStreakDays: 0 });
  });

  it('counts a single day (today) as a 1-day streak', () => {
    const days = { '2026-07-07': 500 };
    expect(computeStreaks(days, NOW)).toEqual({ currentStreakDays: 1, longestStreakDays: 1 });
  });

  it('does not break the streak just because today has no words yet', () => {
    // Wrote yesterday and the day before, nothing logged yet today.
    const days = { '2026-07-05': 300, '2026-07-06': 400 };
    const result = computeStreaks(days, NOW);
    expect(result.currentStreakDays).toBe(2); // yesterday + day before, today pending
    expect(result.longestStreakDays).toBe(2);
  });

  it('breaks the current streak on a gap day', () => {
    // Wrote today and yesterday, but skipped the day before (gap), then wrote further back.
    const days = { '2026-07-07': 100, '2026-07-06': 200, '2026-07-04': 150 };
    const result = computeStreaks(days, NOW);
    expect(result.currentStreakDays).toBe(2); // today + yesterday only
    expect(result.longestStreakDays).toBe(2); // longest run anywhere is also 2
  });

  it('computes a longest streak that is longer than the current streak', () => {
    // A 5-day run in the past, then a gap, then a 2-day current run ending yesterday.
    const days: Record<string, number> = {
      '2026-06-01': 100, '2026-06-02': 100, '2026-06-03': 100, '2026-06-04': 100, '2026-06-05': 100,
      // gap
      '2026-07-06': 100, '2026-07-05': 100,
    };
    const result = computeStreaks(days, NOW);
    expect(result.currentStreakDays).toBe(2);
    expect(result.longestStreakDays).toBe(5);
  });

  it('treats a day with 0 words the same as a missing day (breaks the streak)', () => {
    const days = { '2026-07-07': 100, '2026-07-06': 0, '2026-07-05': 100 };
    const result = computeStreaks(days, NOW);
    expect(result.currentStreakDays).toBe(1); // only today; yesterday was explicitly 0
  });

  it('current streak of 0 when neither today nor yesterday has words, even with older history', () => {
    const days = { '2026-07-01': 500 };
    const result = computeStreaks(days, NOW);
    expect(result.currentStreakDays).toBe(0);
    expect(result.longestStreakDays).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// WritingStatsStore (filesystem-backed, tmp dir per test)
// ═══════════════════════════════════════════════════════════

describe('WritingStatsStore', () => {
  let workspaceDir: string;
  let store: WritingStatsStore;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'authorclaw-writing-stats-'));
    store = new WritingStatsStore(workspaceDir);
  });

  afterEach(() => {
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('starts at zero with no recorded words', async () => {
    const snapshot = await store.getSnapshot(0);
    expect(snapshot).toEqual({
      wordsToday: 0,
      wordsThisWeek: 0,
      wordsTotal: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      activeProjects: 0,
      lastActiveIso: null,
    });
  });

  it('records words for "now" and reflects them in today/week/total', async () => {
    const now = new Date('2026-07-07T15:00:00.000Z');
    await store.recordWords(500, now);
    await store.recordWords(300, now); // additive within the same day

    const snapshot = await store.getSnapshot(2, now);
    expect(snapshot.wordsToday).toBe(800);
    expect(snapshot.wordsThisWeek).toBe(800);
    expect(snapshot.wordsTotal).toBe(800);
    expect(snapshot.activeProjects).toBe(2);
    expect(snapshot.lastActiveIso).toBe(now.toISOString());
  });

  it('ignores non-positive or non-finite word counts', async () => {
    const now = new Date('2026-07-07T15:00:00.000Z');
    await store.recordWords(0, now);
    await store.recordWords(-50, now);
    await store.recordWords(NaN, now);
    const snapshot = await store.getSnapshot(0, now);
    expect(snapshot.wordsToday).toBe(0);
    expect(snapshot.lastActiveIso).toBeNull();
  });

  it('separates "this week" (rolling 7 days) from older totals', async () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const eightDaysAgo = new Date('2026-06-29T12:00:00.000Z'); // outside the 7-day window
    const threeDaysAgo = new Date('2026-07-04T12:00:00.000Z'); // inside the 7-day window

    await store.recordWords(1000, eightDaysAgo);
    await store.recordWords(200, threeDaysAgo);
    await store.recordWords(50, now);

    const snapshot = await store.getSnapshot(0, now);
    expect(snapshot.wordsToday).toBe(50);
    expect(snapshot.wordsThisWeek).toBe(250); // 200 + 50, NOT the 1000 from 8 days ago
    expect(snapshot.wordsTotal).toBe(1250); // total includes everything ever recorded
  });

  it('computes streaks from recorded history via getSnapshot', async () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    await store.recordWords(100, new Date('2026-07-05T12:00:00.000Z'));
    await store.recordWords(100, new Date('2026-07-06T12:00:00.000Z'));
    await store.recordWords(100, now);

    const snapshot = await store.getSnapshot(0, now);
    expect(snapshot.currentStreakDays).toBe(3);
    expect(snapshot.longestStreakDays).toBe(3);
  });

  it('persists to workspace/data/writing-stats.json atomically and survives reload in a new instance', async () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    await store.recordWords(750, now);
    await store.flush();

    const filePath = join(workspaceDir, 'data', 'writing-stats.json');
    expect(existsSync(filePath)).toBe(true);
    // No leftover .tmp file after a successful atomic rename.
    expect(existsSync(filePath + '.tmp')).toBe(false);

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw.days['2026-07-07']).toBe(750);

    // Fresh instance pointed at the same workspace picks up persisted data.
    const reloaded = new WritingStatsStore(workspaceDir);
    const snapshot = await reloaded.getSnapshot(0, now);
    expect(snapshot.wordsToday).toBe(750);
    expect(snapshot.wordsTotal).toBe(750);
  });

  it('never throws even if the underlying file becomes unreadable JSON', async () => {
    const { mkdirSync, writeFileSync } = await import('fs');
    const dataDir = join(workspaceDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'writing-stats.json'), '{ not valid json ][', 'utf-8');

    const corrupted = new WritingStatsStore(workspaceDir);
    // initialize()/getSnapshot() must not throw on corrupted data — starts fresh.
    const snapshot = await corrupted.getSnapshot(0);
    expect(snapshot.wordsToday).toBe(0);
    expect(snapshot.wordsTotal).toBe(0);

    // And recording still works after recovering from corruption.
    await corrupted.recordWords(100);
    const after = await corrupted.getSnapshot(0);
    expect(after.wordsToday).toBe(100);
  });
});
