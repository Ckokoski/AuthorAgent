import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PreferenceStore } from './preferences.js';

// ═══════════════════════════════════════════════════════════
// PreferenceStore.prune (Tiered Memory Chunk C, sleep-job step 6)
// ═══════════════════════════════════════════════════════════

let memoryDir: string;
let store: PreferenceStore;

const NOW = '2026-07-06T00:00:00.000Z';
/** ISO timestamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Directly seed a preference with a chosen source + updatedAt (bypassing set()'s clock). */
async function seed(key: string, value: any, source: any, updatedAt: string): Promise<void> {
  await store.set(key, value, source);
  // set() stamps updatedAt = now; overwrite it via the internal data for a
  // deterministic age. getAllWithMetadata returns a copy, so mutate through a
  // fresh set then patch the on-disk-ish metadata via a re-set is not enough —
  // reach into the instance.
  (store as any).data.metadata[key].updatedAt = updatedAt;
}

beforeEach(async () => {
  memoryDir = mkdtempSync(join(tmpdir(), 'authorclaw-prefs-'));
  store = new PreferenceStore(memoryDir);
  await store.initialize();
});

afterEach(() => {
  try { rmSync(memoryDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('PreferenceStore.prune', () => {
  it('never removes explicit preferences, even when very stale', async () => {
    await seed('writing.pov', 'first person', 'explicit', daysAgo(365));
    const removed = await store.prune(NOW, { maxAgeDays: 90 });
    expect(removed).toEqual([]);
    expect(store.get('writing.pov')).toBe('first person');
  });

  it('removes stale inferred/observed preferences past maxAgeDays', async () => {
    await seed('tone', 'snarky', 'inferred', daysAgo(200));       // stale → removed
    await seed('response.style', 'concise', 'observed', daysAgo(120)); // stale → removed
    await seed('formatting.emojis', 'no emojis', 'inferred', daysAgo(10)); // fresh → kept

    const removed = await store.prune(NOW, { maxAgeDays: 90 });
    expect(removed.sort()).toEqual(['response.style', 'tone']);
    expect(store.get('tone')).toBeUndefined();
    expect(store.get('response.style')).toBeUndefined();
    expect(store.get('formatting.emojis')).toBe('no emojis'); // survived (fresh)
  });

  it('keeps a stale explicit pref but removes a stale inferred one with the same value', async () => {
    await seed('writing.tense', 'past tense', 'explicit', daysAgo(300));   // protected
    await seed('preference.past', 'past tense', 'inferred', daysAgo(300));  // dup + stale → removed

    const removed = await store.prune(NOW, { maxAgeDays: 90 });
    expect(removed).toEqual(['preference.past']);
    expect(store.get('writing.tense')).toBe('past tense');
  });

  it('collapses exact-duplicate values among prunable keys, keeping the freshest', async () => {
    // Two inferred keys with the SAME value; both fresh (not stale), so only the
    // duplicate-collapse rule applies. Keep the most recently updated.
    await seed('preference.dark_gritty', 'avoid: dark', 'inferred', daysAgo(5));  // fresher → kept
    await seed('writing.violence_level', 'avoid: dark', 'inferred', daysAgo(30)); // older dup → removed

    const removed = await store.prune(NOW, { maxAgeDays: 90 });
    expect(removed).toEqual(['writing.violence_level']);
    expect(store.get('preference.dark_gritty')).toBe('avoid: dark');
    expect(store.get('writing.violence_level')).toBeUndefined();
  });

  it('respects a custom protectSources list', async () => {
    await seed('a.observed', 'x', 'observed', daysAgo(200));
    await seed('a.inferred', 'y', 'inferred', daysAgo(200));

    // Protect BOTH explicit and observed; only the inferred stale one goes.
    const removed = await store.prune(NOW, {
      maxAgeDays: 90,
      protectSources: ['explicit', 'observed'],
    });
    expect(removed).toEqual(['a.inferred']);
    expect(store.get('a.observed')).toBe('x'); // protected by source
  });

  it('returns [] and changes nothing when there is nothing to prune', async () => {
    await seed('writing.genre', 'thriller', 'explicit', daysAgo(500));
    await seed('tone', 'casual', 'inferred', daysAgo(1)); // fresh
    const removed = await store.prune(NOW, { maxAgeDays: 90 });
    expect(removed).toEqual([]);
    expect(Object.keys(store.getAll()).sort()).toEqual(['tone', 'writing.genre']);
  });
});
