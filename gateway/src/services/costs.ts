/**
 * AuthorAgent Cost Tracker
 * Budget monitoring with daily/monthly caps.
 * Persisted to disk so budget survives restarts.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

interface CostConfig {
  dailyLimit: number;
  monthlyLimit: number;
  alertAt: number; // percentage (0-1)
  persistPath?: string;
}

interface PersistedState {
  dailySpend: number;
  monthlySpend: number;
  lastResetDay: string;
  lastResetMonth: string;
}

export class CostTracker {
  dailyLimit: number;
  monthlyLimit: number;
  private alertAt: number;
  private dailySpend = 0;
  private monthlySpend = 0;
  private lastResetDay: string;
  private lastResetMonth: string;
  private persistPath?: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<CostConfig>) {
    this.dailyLimit = config.dailyLimit ?? 5;
    this.monthlyLimit = config.monthlyLimit ?? 50;
    this.alertAt = config.alertAt ?? 0.8;
    this.lastResetDay = new Date().toISOString().split('T')[0];
    this.lastResetMonth = new Date().toISOString().substring(0, 7);
    this.persistPath = config.persistPath;
  }

  /**
   * Hydrate state from disk. Call once at startup after construction.
   * Silently returns if no persistPath or no existing state file.
   */
  async initialize(): Promise<void> {
    if (!this.persistPath) return;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      if (!existsSync(this.persistPath)) return;
      const raw = await readFile(this.persistPath, 'utf-8');
      const state: PersistedState = JSON.parse(raw);
      this.dailySpend = state.dailySpend || 0;
      this.monthlySpend = state.monthlySpend || 0;
      this.lastResetDay = state.lastResetDay || this.lastResetDay;
      this.lastResetMonth = state.lastResetMonth || this.lastResetMonth;
      this.checkReset();
    } catch {
      // Corrupted state — start fresh.
    }
  }

  /**
   * Record a cost directly from the router response. Prefer passing the
   * router-supplied `estimatedCost` so we don't disagree with the per-provider
   * pricing table in router.ts.
   */
  record(provider: string, tokens: number, estimatedCost?: number): void {
    this.checkReset();
    let cost = estimatedCost;
    if (cost === undefined || cost === null || isNaN(cost)) {
      // Fallback estimation (matches router defaults). Used only if the router
      // didn't provide a cost (older call-sites).
      const costPer1k: Record<string, number> = {
        ollama: 0, gemini: 0, deepseek: 0.0003,
        claude: 0.009, openai: 0.006, together: 0.0002,
      };
      cost = (tokens / 1000) * (costPer1k[provider] || 0);
    }
    this.dailySpend += cost;
    this.monthlySpend += cost;
    this.schedulePersist();
  }

  isOverBudget(): boolean {
    this.checkReset();
    return this.dailySpend >= this.dailyLimit || this.monthlySpend >= this.monthlyLimit;
  }

  isNearBudget(): boolean {
    this.checkReset();
    return this.dailySpend >= this.dailyLimit * this.alertAt ||
           this.monthlySpend >= this.monthlyLimit * this.alertAt;
  }

  getStatus(): { daily: number; monthly: number; overBudget: boolean; dailyLimit: number; monthlyLimit: number } {
    this.checkReset();
    return {
      daily: Math.round(this.dailySpend * 100) / 100,
      monthly: Math.round(this.monthlySpend * 100) / 100,
      overBudget: this.isOverBudget(),
      dailyLimit: this.dailyLimit,
      monthlyLimit: this.monthlyLimit,
    };
  }

  /** Manual reset — used by dashboard "reset budget" button. */
  async reset(): Promise<void> {
    this.dailySpend = 0;
    this.monthlySpend = 0;
    this.lastResetDay = new Date().toISOString().split('T')[0];
    this.lastResetMonth = new Date().toISOString().substring(0, 7);
    await this.persist();
  }

  private checkReset(): void {
    const today = new Date().toISOString().split('T')[0];
    const month = new Date().toISOString().substring(0, 7);
    let changed = false;
    if (today !== this.lastResetDay) {
      this.dailySpend = 0;
      this.lastResetDay = today;
      changed = true;
    }
    if (month !== this.lastResetMonth) {
      this.monthlySpend = 0;
      this.lastResetMonth = month;
      changed = true;
    }
    if (changed) this.schedulePersist();
  }

  /** Debounced disk write — coalesces rapid `record()` calls into one write. */
  private schedulePersist(): void {
    if (!this.persistPath) return;
    if (this.writeTimer) return; // already scheduled
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(() => {});
    }, 2000);
  }

  private async persist(): Promise<void> {
    if (!this.persistPath) return;
    const state: PersistedState = {
      dailySpend: this.dailySpend,
      monthlySpend: this.monthlySpend,
      lastResetDay: this.lastResetDay,
      lastResetMonth: this.lastResetMonth,
    };
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      // Atomic-ish write: write temp, then rename to avoid corruption on crash.
      const tmp = this.persistPath + '.tmp';
      await writeFile(tmp, JSON.stringify(state, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.persistPath);
    } catch {
      // Non-fatal — cost tracking continues in memory.
    }
  }
}
