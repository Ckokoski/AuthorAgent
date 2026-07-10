/**
 * AuthorAgent Cron Scheduler
 *
 * Hermes-inspired persistent scheduler for recurring tasks. More flexible
 * than the existing Heartbeat (which only runs on a fixed interval).
 *
 * Use cases authors actually want:
 *   - "Every weekday at 9am, ask me what I'm writing today"
 *   - "Every Sunday at 10pm, summarize my week's progress"
 *   - "Every 6 hours, run continuity check on the active project"
 *   - "Daily at midnight, back up workspace + reindex memory search"
 *
 * Cron syntax supported (5-field):
 *   minute hour day-of-month month day-of-week
 *   Each field accepts: star (any), step (every-N), number, range, comma-list.
 *
 * No external dep — small parser + interval ticker. Runs in-process; survives
 * across restarts via persistent state. Job handler is a registered function
 * keyed by name; the scheduler doesn't execute arbitrary code from disk.
 *
 * Security:
 *   - Job handlers must be registered programmatically by the gateway
 *   - User-defined cron entries can ONLY pick from registered handler names
 *   - No shell exec, no eval, no dynamic require
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface CronJob {
  id: string;
  /** Human-readable name. */
  name: string;
  /** Cron expression: "minute hour day-of-month month day-of-week" */
  schedule: string;
  /** Registered handler name to invoke (NOT arbitrary code). */
  handler: string;
  /** Optional payload passed to the handler. */
  payload?: Record<string, any>;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: 'pending' | 'success' | 'failed' | null;
  lastRunMessage: string | null;
  nextRunAt: string | null;
  runCount: number;
}

export type CronHandler = (payload: Record<string, any>) => Promise<{ success: boolean; message?: string }>;

interface PersistedState {
  jobs: CronJob[];
}

// ═══════════════════════════════════════════════════════════
// Parser — minimal but covers the common cron forms authors need
// ═══════════════════════════════════════════════════════════

interface ParsedField {
  /** Set of values this field allows. */
  values: Set<number>;
}

class CronParser {
  static parse(expression: string): {
    minute: ParsedField;
    hour: ParsedField;
    dom: ParsedField;
    month: ParsedField;
    dow: ParsedField;
  } | null {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    const parsed = fields.map((f, i) => CronParser.parseField(f, ranges[i][0], ranges[i][1]));
    if (parsed.some(p => p === null)) return null;
    return {
      minute: parsed[0]!, hour: parsed[1]!, dom: parsed[2]!,
      month: parsed[3]!, dow: parsed[4]!,
    };
  }

  private static parseField(field: string, min: number, max: number): ParsedField | null {
    const values = new Set<number>();
    for (const part of field.split(',')) {
      // step: e.g., */15 or 0-30/5
      const stepMatch = part.match(/^(.+?)\/(\d+)$/);
      let base = part;
      let step = 1;
      if (stepMatch) {
        base = stepMatch[1];
        step = parseInt(stepMatch[2], 10);
        if (!step || step < 1) return null;
      }

      let from = min;
      let to = max;
      if (base === '*') {
        // already min..max
      } else if (/^\d+$/.test(base)) {
        from = to = parseInt(base, 10);
      } else if (/^\d+-\d+$/.test(base)) {
        const [a, b] = base.split('-').map(s => parseInt(s, 10));
        from = a; to = b;
      } else {
        return null;
      }
      if (from < min || to > max || from > to) return null;
      for (let v = from; v <= to; v += step) values.add(v);
    }
    return { values };
  }

  static matches(d: Date, parsed: ReturnType<typeof CronParser.parse>): boolean {
    if (!parsed) return false;
    return parsed.minute.values.has(d.getUTCMinutes())
      && parsed.hour.values.has(d.getUTCHours())
      && parsed.dom.values.has(d.getUTCDate())
      && parsed.month.values.has(d.getUTCMonth() + 1)
      && parsed.dow.values.has(d.getUTCDay());
  }

  /** Compute next match starting from `from` (inclusive of next minute). */
  static nextRun(parsed: ReturnType<typeof CronParser.parse>, from: Date = new Date()): Date | null {
    if (!parsed) return null;
    // Advance by minute up to 4 years; cap to avoid infinite loops on
    // impossible expressions (e.g., 31 in Feb).
    const start = new Date(from);
    start.setUTCSeconds(0, 0);
    start.setUTCMinutes(start.getUTCMinutes() + 1);
    const cap = new Date(from.getTime() + 366 * 4 * 86400000);
    const cur = new Date(start);
    while (cur < cap) {
      if (CronParser.matches(cur, parsed)) return cur;
      cur.setUTCMinutes(cur.getUTCMinutes() + 1);
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class CronSchedulerService {
  private state: PersistedState = { jobs: [] };
  private filePath: string;
  private handlers: Map<string, CronHandler> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private running = new Set<string>(); // jobs currently executing

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'cron-jobs.json');
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (existsSync(this.filePath)) {
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      } catch { /* corrupted — start fresh */ }
    }
    // Recompute nextRunAt on every job (clock may have moved).
    for (const job of this.state.jobs) {
      this.recomputeNextRun(job);
    }
  }

  /** Register a named handler. Cron jobs reference handlers by name only. */
  registerHandler(name: string, handler: CronHandler): void {
    this.handlers.set(name, handler);
  }

  listHandlers(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  start(): void {
    if (this.tickInterval) return;
    // Tick every 30 seconds — granular enough for minute-level cron without
    // burning CPU. Most cron implementations use minute-level dispatch but
    // tick more often to reduce drift.
    this.tickInterval = setInterval(() => this.tick(), 30000);
    // Run once immediately so jobs that were due during downtime fire.
    setImmediate(() => this.tick());
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ── Job CRUD ──

  async createJob(input: {
    name: string;
    schedule: string;
    handler: string;
    payload?: Record<string, any>;
    enabled?: boolean;
  }): Promise<CronJob> {
    if (!CronParser.parse(input.schedule)) {
      throw new Error(`Invalid cron expression: "${input.schedule}". Use 5 fields: "minute hour day-of-month month day-of-week".`);
    }
    if (!this.handlers.has(input.handler)) {
      throw new Error(`Unknown handler "${input.handler}". Registered: ${this.listHandlers().join(', ') || '(none)'}`);
    }
    const job: CronJob = {
      id: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: input.name,
      schedule: input.schedule,
      handler: input.handler,
      payload: input.payload,
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      nextRunAt: null,
      runCount: 0,
    };
    this.recomputeNextRun(job);
    this.state.jobs.push(job);
    this.schedulePersist();
    return job;
  }

  async updateJob(id: string, updates: Partial<Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'runCount'>>): Promise<CronJob | null> {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job) return null;
    if (updates.schedule && !CronParser.parse(updates.schedule)) {
      throw new Error(`Invalid cron expression: "${updates.schedule}"`);
    }
    if (updates.handler && !this.handlers.has(updates.handler)) {
      throw new Error(`Unknown handler "${updates.handler}"`);
    }
    Object.assign(job, updates);
    this.recomputeNextRun(job);
    this.schedulePersist();
    return job;
  }

  async deleteJob(id: string): Promise<boolean> {
    const idx = this.state.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.state.jobs.splice(idx, 1);
    this.schedulePersist();
    return true;
  }

  list(): CronJob[] {
    return [...this.state.jobs].sort((a, b) => (a.nextRunAt || '').localeCompare(b.nextRunAt || ''));
  }

  get(id: string): CronJob | undefined {
    return this.state.jobs.find(j => j.id === id);
  }

  /** Manually run a job NOW. Useful for testing without waiting. */
  async runNow(id: string): Promise<{ success: boolean; message?: string }> {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job) return { success: false, message: 'Job not found' };
    return this.executeJob(job);
  }

  // ── Internal ──

  private recomputeNextRun(job: CronJob): void {
    const parsed = CronParser.parse(job.schedule);
    const next = CronParser.nextRun(parsed);
    job.nextRunAt = next ? next.toISOString() : null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const job of this.state.jobs) {
      if (!job.enabled || this.running.has(job.id)) continue;
      if (!job.nextRunAt) continue;
      if (new Date(job.nextRunAt).getTime() > now.getTime()) continue;

      // Fire and update next run.
      this.running.add(job.id);
      this.executeJob(job)
        .catch(err => {
          job.lastRunStatus = 'failed';
          job.lastRunMessage = String(err?.message || err);
        })
        .finally(() => {
          this.running.delete(job.id);
          job.lastRunAt = new Date().toISOString();
          job.runCount++;
          this.recomputeNextRun(job);
          this.schedulePersist();
        });
    }
  }

  private async executeJob(job: CronJob): Promise<{ success: boolean; message?: string }> {
    const handler = this.handlers.get(job.handler);
    if (!handler) {
      const result = { success: false, message: `Handler "${job.handler}" not registered` };
      job.lastRunStatus = 'failed';
      job.lastRunMessage = result.message;
      return result;
    }
    try {
      const result = await handler(job.payload || {});
      job.lastRunStatus = result.success ? 'success' : 'failed';
      job.lastRunMessage = result.message || null;
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      job.lastRunStatus = 'failed';
      job.lastRunMessage = msg;
      return { success: false, message: msg };
    }
  }

  private schedulePersist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(() => {});
    }, 1000);
  }

  private async persist(): Promise<void> {
    try {
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist cron state:', err);
    }
  }
}

/** Helper: validate a cron expression without instantiating a job. */
export function validateCronExpression(expr: string): { valid: boolean; nextRun?: string; error?: string } {
  const parsed = CronParser.parse(expr);
  if (!parsed) return { valid: false, error: `Use 5 fields: "minute hour day-of-month month day-of-week"` };
  const next = CronParser.nextRun(parsed);
  return { valid: true, nextRun: next?.toISOString() };
}
