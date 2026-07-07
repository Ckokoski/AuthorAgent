/**
 * AuthorClaw Writing Stats Store
 *
 * Minimal, additive, per-day word tally used to power the "Author HQ"
 * dashboard (today/week/total words, streaks). This does NOT replace
 * HeartbeatService's in-memory today/streak counters (still used for
 * Morning Briefing + reminder milestones) — it exists because heartbeat's
 * counters reset on process restart and only ever know about "today".
 *
 * Design goals:
 *  - Never throw. Every public method swallows its own errors so a store
 *    hiccup can NEVER break the step-completion write path that calls
 *    HeartbeatService.addWords() (see heartbeat.ts).
 *  - Debounced + atomic writes (write to .tmp, then rename), matching the
 *    convention used by Vault.save() and GoalsService.schedulePersist().
 *  - Small and dependency-free: one JSON file, one Map of date -> words.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface WritingStatsSnapshot {
  wordsToday: number;
  wordsThisWeek: number;
  wordsTotal: number;
  currentStreakDays: number;
  longestStreakDays: number;
  activeProjects: number;
  lastActiveIso: string | null;
}

interface WritingStatsData {
  version: 1;
  /** date (YYYY-MM-DD, local) -> words recorded that day */
  days: Record<string, number>;
  lastActiveIso: string | null;
}

const FILE_NAME = 'writing-stats.json';
const DEBOUNCE_MS = 2000;

/** YYYY-MM-DD for a given Date, using local time (matches heartbeat.ts's use of toISOString().split('T')[0] closely enough for a daily tally; callers can pass a fixed `now` in tests for determinism). */
function dateKey(d: Date): string {
  return d.toISOString().split('T')[0];
}

export class WritingStatsStore {
  private filePath: string;
  private data: WritingStatsData = { version: 1, days: {}, lastActiveIso: null };
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite = false;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'data', FILE_NAME);
  }

  /** Load persisted data from disk. Safe to call multiple times; safe to skip (lazy-loads on first record/read). Never throws. */
  async initialize(): Promise<void> {
    if (this.loaded) return;
    try {
      const dir = join(this.filePath, '..');
      await mkdir(dir, { recursive: true });
      if (existsSync(this.filePath)) {
        const raw = await readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
          this.data = {
            version: 1,
            days: { ...parsed.days },
            lastActiveIso: typeof parsed.lastActiveIso === 'string' ? parsed.lastActiveIso : null,
          };
        }
      }
    } catch {
      // Corrupted or unreadable — start fresh rather than blocking anything.
      this.data = { version: 1, days: {}, lastActiveIso: null };
    }
    this.loaded = true;
  }

  /**
   * Record `count` words for "now" (or an injected date, for tests/manual
   * backfill). Additive — repeated calls on the same day accumulate.
   * Debounced + atomic persist. Never throws (best-effort; a failed write
   * only means the dashboard undercounts until the next successful save,
   * it never breaks the caller).
   */
  async recordWords(count: number, now: Date = new Date()): Promise<void> {
    if (!Number.isFinite(count) || count <= 0) return;
    try {
      await this.initialize();
      const key = dateKey(now);
      this.data.days[key] = (this.data.days[key] || 0) + Math.round(count);
      this.data.lastActiveIso = now.toISOString();
      this.schedulePersist();
    } catch {
      // Never let stats tracking break the writing path.
    }
  }

  /** Force any pending debounced write to flush immediately (used by tests / graceful shutdown). */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pendingWrite) {
      await this.persistNow();
    }
  }

  private schedulePersist(): void {
    this.pendingWrite = true;
    if (this.writeTimer) return; // already scheduled
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persistNow().catch(() => { /* best-effort */ });
    }, DEBOUNCE_MS);
    // Don't hold the process open just for this timer.
    if (typeof (this.writeTimer as any)?.unref === 'function') {
      (this.writeTimer as any).unref();
    }
  }

  private async persistNow(): Promise<void> {
    try {
      this.pendingWrite = false;
      const dir = join(this.filePath, '..');
      await mkdir(dir, { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      await rename(tmpPath, this.filePath);
    } catch {
      // Best-effort — swallow. Next recordWords() call will retry the schedule.
    }
  }

  /**
   * Compute the dashboard snapshot. `activeProjects` is supplied by the
   * caller (route already reads workspace/projects) since this store has no
   * knowledge of projects — keeps this module single-purpose.
   */
  async getSnapshot(activeProjects: number, now: Date = new Date()): Promise<WritingStatsSnapshot> {
    try {
      await this.initialize();
    } catch {
      // fall through with whatever is in this.data (possibly empty defaults)
    }

    const todayKey = dateKey(now);
    const wordsToday = this.data.days[todayKey] || 0;

    // "This week" = trailing 7 days including today (rolling window, not
    // calendar-week) — simplest definition that needs no week-start config.
    let wordsThisWeek = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      wordsThisWeek += this.data.days[dateKey(d)] || 0;
    }

    const wordsTotal = Object.values(this.data.days).reduce((sum, n) => sum + n, 0);

    const { currentStreakDays, longestStreakDays } = computeStreaks(this.data.days, now);

    return {
      wordsToday,
      wordsThisWeek,
      wordsTotal,
      currentStreakDays,
      longestStreakDays,
      activeProjects,
      lastActiveIso: this.data.lastActiveIso,
    };
  }
}

/**
 * Streak computation, exported standalone so it can be unit-tested against
 * a plain `{ [date]: words }` map without needing a store instance or a real
 * filesystem.
 *
 *  - currentStreakDays: consecutive days with words > 0, counting backward
 *    from `now`. A day with 0 (or missing) words breaks the streak UNLESS
 *    it's "today" and today just hasn't been written in yet (today doesn't
 *    break an otherwise-live streak; it just doesn't extend it either until
 *    words are logged).
 *  - longestStreakDays: the longest run of consecutive days with words > 0
 *    anywhere in the recorded history.
 */
export function computeStreaks(
  days: Record<string, number>,
  now: Date = new Date()
): { currentStreakDays: number; longestStreakDays: number } {
  const hasWords = (d: Date) => (days[dateKey(d)] || 0) > 0;

  // ── Current streak: walk backward from today ──
  let currentStreakDays = 0;
  const cursor = new Date(now);
  // If today has no words yet, don't count it as a break — just start
  // counting from yesterday. If today HAS words, include it.
  if (hasWords(cursor)) {
    currentStreakDays = 1;
  }
  cursor.setDate(cursor.getDate() - 1);
  while (hasWords(cursor)) {
    currentStreakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // ── Longest streak: scan all recorded dates in sorted order ──
  const sortedDates = Object.keys(days)
    .filter(k => (days[k] || 0) > 0)
    .sort(); // ISO date strings sort chronologically as plain strings

  let longestStreakDays = 0;
  let runLength = 0;
  let prevDate: Date | null = null;

  for (const dateStr of sortedDates) {
    const d = new Date(dateStr + 'T00:00:00.000Z');
    if (prevDate) {
      const dayDiff = Math.round((d.getTime() - prevDate.getTime()) / 86_400_000);
      if (dayDiff === 1) {
        runLength++;
      } else {
        runLength = 1;
      }
    } else {
      runLength = 1;
    }
    longestStreakDays = Math.max(longestStreakDays, runLength);
    prevDate = d;
  }

  // The current streak might itself be the longest one on record.
  longestStreakDays = Math.max(longestStreakDays, currentStreakDays);

  return { currentStreakDays, longestStreakDays };
}
