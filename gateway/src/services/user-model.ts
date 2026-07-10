/**
 * AuthorAgent User Model — Honcho-inspired dialectic modeling, simplified.
 *
 * Honcho (Plastic Labs) builds user models via two LLMs in a dialectic loop:
 * one observes raw conversation, the other challenges and refines the
 * resulting model. AuthorAgent does the simpler version — single periodic
 * consolidation pass — because we don't need real-time refinement and we
 * want to keep AI cost predictable.
 *
 * What this service tracks (vs. PreferenceStore which is just key/value):
 *
 *   1. Behavioral observations — counts/timings of actions over time
 *      (sessions, words written, projects completed, time-of-day, day-of-week)
 *
 *   2. Communication patterns — avg message length, messages per session,
 *      use of slash commands vs. natural language
 *
 *   3. Writing style fingerprint — averaged StyleClone markers from any
 *      writing the user has done in AuthorAgent
 *
 *   4. Working patterns — session length, words/hour, day-of-week clustering
 *
 *   5. Consolidated insights — periodic LLM-generated narrative summary of
 *      "what I know about this author" that gets injected into the system
 *      prompt (separate from the simple bullet-list of preferences)
 *
 * The model deepens over time. Every 20 turns OR once per day (whichever
 * comes first), a consolidation pass runs that takes the previous model +
 * recent raw observations and produces an updated profile narrative. This
 * is the only AI call in this service — and it's gated by user budget.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface BehavioralObservation {
  timestamp: string;
  type:
    | 'session_start'
    | 'message_sent'
    | 'words_written'
    | 'project_completed'
    | 'project_failed'
    | 'edit_accepted'
    | 'edit_rejected'
    | 'preference_changed';
  metadata?: Record<string, any>;
  // The active persona at the time of the observation. Lets us model
  // each pen name as a separate "voice" inside one author's profile.
  personaId: string | null;
}

export interface UserModelSnapshot {
  /** When this snapshot was generated. */
  generatedAt: string;
  /** Total observations consumed to build this snapshot. */
  observationCount: number;

  // ── Quantitative profile (deterministic, no LLM needed) ──
  metrics: {
    totalSessions: number;
    totalMessages: number;
    totalWordsWritten: number;
    avgMessageLength: number;
    avgWordsPerSession: number;
    activeDays: number;
    longestStreak: number;
    preferredHourOfDay: number | null; // 0–23, mode of session-start hours
    preferredDayOfWeek: string | null; // 'Monday' .. 'Sunday'
    completedProjects: number;
    failedProjects: number;
    completionRate: number; // 0–1
  };

  // ── Per-persona breakdown (Hermes/Honcho-style identity scoping) ──
  personas: Record<string, {
    messages: number;
    wordsWritten: number;
    projectsCompleted: number;
    lastActiveAt: string;
  }>;

  // ── Narrative consolidation (LLM-generated, optional) ──
  narrative: {
    text: string;            // 200-400 word natural-language profile
    confidence: number;      // 0-1; higher = more data behind the model
    consolidatedAt: string;
    consolidationCount: number;
  };
}

interface PersistedState {
  observations: BehavioralObservation[]; // ring buffer, capped
  snapshot: UserModelSnapshot | null;
  lastConsolidationAt: string | null;
  observationsSinceConsolidation: number;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const MAX_OBSERVATIONS = 5000;          // ring buffer cap
const CONSOLIDATION_TURNS_THRESHOLD = 20; // run consolidation after N message_sent events
const CONSOLIDATION_DAY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const CONSOLIDATION_PROMPT = `You are building a deepening user-model narrative for an author who uses an AI writing tool. You will be given the previous narrative (if any) plus a list of recent behavioral observations. Produce an UPDATED narrative — 200-400 words, written in third person — that captures what we now know about this author.

Cover (only when supported by data — do NOT invent):
  - Working rhythm (when, how often, how long, day-of-week patterns)
  - Productivity signals (words/session, completion rate, project velocity)
  - Voice / style trends (POV, tense, recurring themes if discernible)
  - Communication style (formal/casual, prefers commands vs conversation)
  - Per-persona patterns when multiple pen names are observed
  - Notable shifts since the previous narrative (growth, pivots, slumps)

Do NOT include:
  - Specific dollar amounts
  - Exact dates beyond month-level
  - Real-name PII (except the author's chosen pen names)
  - Speculation that isn't grounded in the observations

Keep it factual, useful, and in the spirit of "if this user came back tomorrow, what would help me serve them better?". Output ONLY the narrative — no headers, no bullet lists.`;

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string }>;

export type AIProviderSelectFn = (taskType: string) => { id: string };

export class UserModelService {
  private state: PersistedState;
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  // AI hooks for periodic consolidation. Optional — service still tracks
  // metrics if these aren't wired.
  private aiComplete: AICompleteFn | null = null;
  private aiSelectProvider: AIProviderSelectFn | null = null;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'memory', 'user-model.json');
    this.state = {
      observations: [],
      snapshot: null,
      lastConsolidationAt: null,
      observationsSinceConsolidation: 0,
    };
  }

  setAI(completeFn: AICompleteFn, selectFn: AIProviderSelectFn): void {
    this.aiComplete = completeFn;
    this.aiSelectProvider = selectFn;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const loaded = JSON.parse(raw);
      this.state = {
        observations: Array.isArray(loaded.observations) ? loaded.observations : [],
        snapshot: loaded.snapshot || null,
        lastConsolidationAt: loaded.lastConsolidationAt || null,
        observationsSinceConsolidation: loaded.observationsSinceConsolidation || 0,
      };
    } catch {
      // Corrupted — start fresh.
    }
  }

  /** Record an observation. Cheap; just appends to the ring buffer. */
  observe(input: Omit<BehavioralObservation, 'timestamp'>): void {
    const obs: BehavioralObservation = {
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.state.observations.push(obs);
    if (this.state.observations.length > MAX_OBSERVATIONS) {
      // Drop oldest
      this.state.observations.splice(0, this.state.observations.length - MAX_OBSERVATIONS);
    }
    if (input.type === 'message_sent') {
      this.state.observationsSinceConsolidation++;
    }
    this.schedulePersist();
  }

  /**
   * Compute the deterministic metrics from raw observations. No AI needed.
   * Cheap — runs in O(n) where n is bounded at MAX_OBSERVATIONS.
   */
  computeMetrics(): UserModelSnapshot['metrics'] {
    const obs = this.state.observations;
    let totalMessages = 0;
    let totalWords = 0;
    let messageLengthSum = 0;
    let messageCountForLength = 0;
    let sessionsStarted = 0;
    let completedProjects = 0;
    let failedProjects = 0;
    const dayCounts = new Map<string, number>();      // YYYY-MM-DD → count
    const hourCounts = new Map<number, number>();
    const dowCounts = new Map<number, number>();
    const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const o of obs) {
      const date = o.timestamp.split('T')[0];
      dayCounts.set(date, (dayCounts.get(date) || 0) + 1);
      const d = new Date(o.timestamp);
      const hour = d.getUTCHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      const dow = d.getUTCDay();
      dowCounts.set(dow, (dowCounts.get(dow) || 0) + 1);

      if (o.type === 'message_sent') {
        totalMessages++;
        const len = Number(o.metadata?.length) || 0;
        if (len > 0) { messageLengthSum += len; messageCountForLength++; }
      } else if (o.type === 'words_written') {
        totalWords += Number(o.metadata?.words) || 0;
      } else if (o.type === 'session_start') {
        sessionsStarted++;
      } else if (o.type === 'project_completed') {
        completedProjects++;
      } else if (o.type === 'project_failed') {
        failedProjects++;
      }
    }

    const activeDays = dayCounts.size;
    const totalProjects = completedProjects + failedProjects;
    const completionRate = totalProjects > 0 ? completedProjects / totalProjects : 0;
    const avgMessageLength = messageCountForLength > 0
      ? Math.round(messageLengthSum / messageCountForLength) : 0;
    const avgWordsPerSession = sessionsStarted > 0
      ? Math.round(totalWords / sessionsStarted) : 0;

    // Mode of hour-of-day across observations
    let preferredHourOfDay: number | null = null;
    let maxHour = 0;
    for (const [hour, count] of hourCounts) {
      if (count > maxHour) { maxHour = count; preferredHourOfDay = hour; }
    }

    let preferredDayOfWeek: string | null = null;
    let maxDow = 0;
    for (const [dow, count] of dowCounts) {
      if (count > maxDow) { maxDow = count; preferredDayOfWeek = dowNames[dow]; }
    }

    // Longest consecutive-day streak (rough — counts unique active dates)
    const sortedDays = [...dayCounts.keys()].sort();
    let longestStreak = sortedDays.length > 0 ? 1 : 0;
    let currentStreak = sortedDays.length > 0 ? 1 : 0;
    for (let i = 1; i < sortedDays.length; i++) {
      const prev = new Date(sortedDays[i - 1]).getTime();
      const curr = new Date(sortedDays[i]).getTime();
      if (curr - prev <= 86400000 + 3600000) { // within 25 hours
        currentStreak++;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
      } else {
        currentStreak = 1;
      }
    }

    return {
      totalSessions: sessionsStarted,
      totalMessages,
      totalWordsWritten: totalWords,
      avgMessageLength,
      avgWordsPerSession,
      activeDays,
      longestStreak,
      preferredHourOfDay,
      preferredDayOfWeek,
      completedProjects,
      failedProjects,
      completionRate: Math.round(completionRate * 100) / 100,
    };
  }

  /** Compute the per-persona breakdown. Same observations, grouped. */
  private computePersonaBreakdown(): UserModelSnapshot['personas'] {
    const result: UserModelSnapshot['personas'] = {};
    for (const o of this.state.observations) {
      const key = o.personaId || '__unscoped';
      if (!result[key]) {
        result[key] = { messages: 0, wordsWritten: 0, projectsCompleted: 0, lastActiveAt: o.timestamp };
      }
      const bucket = result[key];
      if (o.type === 'message_sent') bucket.messages++;
      else if (o.type === 'words_written') bucket.wordsWritten += Number(o.metadata?.words) || 0;
      else if (o.type === 'project_completed') bucket.projectsCompleted++;
      if (o.timestamp > bucket.lastActiveAt) bucket.lastActiveAt = o.timestamp;
    }
    return result;
  }

  /**
   * Run the periodic LLM consolidation. Updates snapshot.narrative.
   * Returns null if consolidation didn't run (no AI wired, or budget cap).
   */
  async maybeConsolidate(force = false): Promise<UserModelSnapshot | null> {
    if (!this.aiComplete || !this.aiSelectProvider) return null;

    // Throttle: only run when threshold met (or forced).
    const lastConsolidationTime = this.state.lastConsolidationAt
      ? new Date(this.state.lastConsolidationAt).getTime() : 0;
    const sinceMs = Date.now() - lastConsolidationTime;
    const turnsThresholdMet = this.state.observationsSinceConsolidation >= CONSOLIDATION_TURNS_THRESHOLD;
    const dayThresholdMet = sinceMs >= CONSOLIDATION_DAY_THRESHOLD_MS;
    if (!force && !turnsThresholdMet && !dayThresholdMet) {
      // Not enough new data — return the existing snapshot if any.
      return this.state.snapshot;
    }

    const metrics = this.computeMetrics();
    const personas = this.computePersonaBreakdown();

    // Build the user message: previous narrative + recent observations
    const recentObs = this.state.observations.slice(-200); // last 200
    const obsSummary = recentObs.map(o => {
      const meta = o.metadata ? ` ${JSON.stringify(o.metadata).substring(0, 200)}` : '';
      return `[${o.timestamp.substring(0, 16)}] ${o.type}${o.personaId ? ` persona=${o.personaId}` : ''}${meta}`;
    }).join('\n');

    const userMessage = [
      `Previous narrative:`,
      this.state.snapshot?.narrative.text || '(none — this is the first consolidation)',
      ``,
      `Quantitative metrics:`,
      JSON.stringify(metrics, null, 2),
      ``,
      `Per-persona breakdown:`,
      JSON.stringify(personas, null, 2),
      ``,
      `Recent observations (last ${recentObs.length}):`,
      obsSummary || '(none)',
    ].join('\n');

    let narrativeText = '';
    try {
      const provider = this.aiSelectProvider('general');
      const response = await this.aiComplete({
        provider: provider.id,
        system: CONSOLIDATION_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 800,
        temperature: 0.5,
      });
      narrativeText = (response.text || '').trim();
    } catch (err) {
      console.warn('  [user-model] consolidation failed:', (err as Error)?.message || err);
      // Keep existing snapshot if AI errored.
      return this.state.snapshot;
    }

    if (!narrativeText) return this.state.snapshot;

    // Confidence rises with observation count (asymptotic to 1.0)
    const confidence = Math.min(0.95, 1 - Math.exp(-this.state.observations.length / 500));

    const snapshot: UserModelSnapshot = {
      generatedAt: new Date().toISOString(),
      observationCount: this.state.observations.length,
      metrics,
      personas,
      narrative: {
        text: narrativeText,
        confidence: Math.round(confidence * 100) / 100,
        consolidatedAt: new Date().toISOString(),
        consolidationCount: (this.state.snapshot?.narrative.consolidationCount || 0) + 1,
      },
    };

    this.state.snapshot = snapshot;
    this.state.lastConsolidationAt = snapshot.generatedAt;
    this.state.observationsSinceConsolidation = 0;
    this.schedulePersist();
    return snapshot;
  }

  /** Read the current snapshot — does not trigger consolidation. */
  getSnapshot(): UserModelSnapshot | null {
    if (!this.state.snapshot) {
      // Build a metrics-only snapshot if no narrative exists yet.
      if (this.state.observations.length === 0) return null;
      return {
        generatedAt: new Date().toISOString(),
        observationCount: this.state.observations.length,
        metrics: this.computeMetrics(),
        personas: this.computePersonaBreakdown(),
        narrative: {
          text: '(narrative not yet generated — needs an AI provider and at least one consolidation pass)',
          confidence: 0,
          consolidatedAt: '',
          consolidationCount: 0,
        },
      };
    }
    return this.state.snapshot;
  }

  /**
   * Format the user model for system-prompt injection. Keeps the size small
   * (~300 tokens) so it doesn't dominate context.
   */
  buildContext(maxTokens = 400): string {
    const snap = this.getSnapshot();
    if (!snap) return '';
    const lines: string[] = ['## What I know about you'];

    if (snap.narrative.text && !snap.narrative.text.startsWith('(narrative not yet')) {
      lines.push(snap.narrative.text);
    }

    // Add a one-line metrics tail so the model has cold-numbers grounding.
    const m = snap.metrics;
    const tail: string[] = [];
    if (m.totalWordsWritten > 0) tail.push(`${m.totalWordsWritten.toLocaleString()} words written here`);
    if (m.completedProjects > 0) tail.push(`${m.completedProjects} project${m.completedProjects === 1 ? '' : 's'} completed`);
    if (m.activeDays > 0) tail.push(`active ${m.activeDays} day${m.activeDays === 1 ? '' : 's'}`);
    if (m.preferredHourOfDay !== null) tail.push(`peak hour ~${m.preferredHourOfDay}:00 UTC`);
    if (tail.length > 0) lines.push(`(${tail.join(' · ')})`);

    const result = lines.join('\n');
    // Crude token cap — chars/4 ≈ tokens
    if (result.length > maxTokens * 4) {
      return result.substring(0, maxTokens * 4) + '…';
    }
    return result;
  }

  async reset(): Promise<void> {
    this.state = {
      observations: [],
      snapshot: null,
      lastConsolidationAt: null,
      observationsSinceConsolidation: 0,
    };
    await this.persist();
  }

  // ── Persistence (debounced) ──

  private schedulePersist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(() => {});
    }, 5000);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist user model:', err);
    }
  }
}
