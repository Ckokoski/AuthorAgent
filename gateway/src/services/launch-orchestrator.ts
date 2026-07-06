/**
 * AuthorClaw Launch Orchestrator
 *
 * State machine for book launches. Given a finished manuscript + cover +
 * metadata, orchestrates the 90-day launch pipeline: KDP metadata → pre-order
 * → ARC team seeding → launch-day price pulse → ad-campaign kickoff →
 * 30/60/90-day follow-ups.
 *
 * CRITICAL: This service does NOT execute anything irreversible on its own.
 * Every step that writes to an external platform (KDP Publish, ARC email send,
 * AMS campaign launch, BookBub submit) creates a ConfirmationRequest and
 * WAITS for user approval. Execution is deferred to whoever picks up the
 * approved request — typically a Claude-in-Chrome MCP session driven by the
 * user in the dashboard.
 *
 * The orchestrator's job is:
 *   1. Plan the full launch timeline
 *   2. Generate the assets (metadata drafts, keyword harvests, copy variants)
 *   3. Produce confirmation requests for each external action, with full
 *      dry-run diffs, rollback steps, disclosure requirements, and risk levels
 *   4. Track launch state per-title so we know where we are in the pipeline
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ConfirmationGateService } from './confirmation-gate.js';
import type { DisclosuresService, DisclosureScope } from './disclosures.js';
import { PRICING, type CostConfidence } from './pricing.js';

export type LaunchPhase =
  | 'draft_ready'
  | 'cover_done'
  | 'metadata_drafted'
  | 'keywords_chosen'
  | 'pre_order_live'
  | 'arc_seeded'
  | 'launch_day'
  | 'follow_up_30'
  | 'follow_up_60'
  | 'follow_up_90'
  | 'complete';

export interface LaunchState {
  id: string;
  projectId: string;
  bookTitle: string;
  authorName: string;
  currentPhase: LaunchPhase;
  targetReleaseDate: string;         // ISO
  createdAt: string;
  updatedAt: string;
  phaseHistory: Array<{
    phase: LaunchPhase;
    enteredAt: string;
    confirmationId?: string;
    outcome?: string;
  }>;
  metadata: LaunchMetadata;
  aiDisclosuresAcknowledged: DisclosureScope[];
}

export interface LaunchMetadata {
  blurb?: string;
  keywords?: string[];                // 7 KDP keywords
  categories?: string[];              // 2 KDP categories
  comps?: string[];                   // Comparable titles
  seriesInfo?: { name: string; number: number };
  priceUSD?: number;
  pricingPulsePlan?: Array<{ day: number; priceUSD: number; note?: string }>;
  arcListSize?: number;
  preOrderLeadDays?: number;
}

export interface LaunchPlan {
  state: LaunchState;
  timeline: Array<{
    dayOffset: number;                // Days from target release (negative = pre)
    date: string;                     // ISO
    phase: LaunchPhase;
    action: string;
    platform: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    requiresConfirmation: boolean;
    disclosures: DisclosureScope[];
  }>;
  totalSteps: number;
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class LaunchOrchestratorService {
  private states: Map<string, LaunchState> = new Map();
  private filePath: string;
  private gate: ConfirmationGateService | null = null;
  private disclosures: DisclosuresService | null = null;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'launches.json');
  }

  setDependencies(gate: ConfirmationGateService, disclosures: DisclosuresService): void {
    this.gate = gate;
    this.disclosures = disclosures;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const arr: LaunchState[] = Array.isArray(parsed.launches) ? parsed.launches : [];
      for (const s of arr) this.states.set(s.id, s);
    } catch {
      this.states = new Map();
    }
  }

  // ── CRUD ──

  async createLaunch(input: {
    projectId: string;
    bookTitle: string;
    authorName: string;
    targetReleaseDate: string;
    metadata?: Partial<LaunchMetadata>;
  }): Promise<LaunchState> {
    const now = new Date().toISOString();
    const state: LaunchState = {
      id: `launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: input.projectId,
      bookTitle: input.bookTitle,
      authorName: input.authorName,
      currentPhase: 'draft_ready',
      targetReleaseDate: input.targetReleaseDate,
      createdAt: now,
      updatedAt: now,
      phaseHistory: [{ phase: 'draft_ready', enteredAt: now }],
      metadata: input.metadata || {},
      aiDisclosuresAcknowledged: [],
    };
    this.states.set(state.id, state);
    await this.persist();
    return state;
  }

  getLaunch(id: string): LaunchState | undefined {
    return this.states.get(id);
  }

  listLaunches(): LaunchState[] {
    return Array.from(this.states.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateMetadata(launchId: string, metadata: Partial<LaunchMetadata>): Promise<LaunchState | null> {
    const state = this.states.get(launchId);
    if (!state) return null;
    state.metadata = { ...state.metadata, ...metadata };
    state.updatedAt = new Date().toISOString();
    await this.persist();
    return state;
  }

  async acknowledgeDisclosures(launchId: string, scopes: DisclosureScope[]): Promise<LaunchState | null> {
    const state = this.states.get(launchId);
    if (!state) return null;
    const merged = new Set(state.aiDisclosuresAcknowledged);
    for (const s of scopes) merged.add(s);
    state.aiDisclosuresAcknowledged = Array.from(merged);
    state.updatedAt = new Date().toISOString();
    await this.persist();
    return state;
  }

  async deleteLaunch(launchId: string): Promise<boolean> {
    const existed = this.states.delete(launchId);
    if (existed) await this.persist();
    return existed;
  }

  /**
   * Build the full 90-day launch plan. Pure function — doesn't create
   * confirmations yet, just shows the user what's coming.
   */
  buildPlan(state: LaunchState): LaunchPlan {
    const release = new Date(state.targetReleaseDate).getTime();
    const warnings: string[] = [];
    const timeline: LaunchPlan['timeline'] = [];

    const addStep = (dayOffset: number, phase: LaunchPhase, action: string, platform: string,
      risk: LaunchPlan['timeline'][0]['riskLevel'], disclosures: DisclosureScope[] = []) => {
      timeline.push({
        dayOffset,
        date: new Date(release + dayOffset * 86400000).toISOString(),
        phase,
        action,
        platform,
        riskLevel: risk,
        requiresConfirmation: risk !== 'low',
        disclosures,
      });
    };

    // ── Pre-launch (90 days out) ──
    const preOrderLead = state.metadata.preOrderLeadDays ?? 30;
    addStep(-preOrderLead - 14, 'metadata_drafted', 'Draft KDP metadata (blurb, keywords, categories)', 'Internal', 'low');
    addStep(-preOrderLead - 10, 'keywords_chosen', 'Harvest keywords from comp-title ASINs', 'Amazon (read-only)', 'low');
    addStep(-preOrderLead, 'pre_order_live', 'Set up KDP pre-order', 'Amazon KDP', 'high',
      ['ai_generated_text', 'ai_generated_art']);

    // ── ARC seeding (21 days before) ──
    addStep(-21, 'arc_seeded', 'Generate ARC list & BookFunnel delivery', 'BookFunnel', 'medium', ['reader_data']);
    addStep(-21, 'arc_seeded', 'Send ARC to reader team', 'Email ESP', 'high', ['reader_data']);

    // ── Launch day ──
    addStep(0, 'launch_day', 'Flip KDP pre-order to live', 'Amazon KDP', 'critical',
      ['ai_generated_text', 'ai_generated_art']);
    addStep(0, 'launch_day', 'Send launch email to main list', 'Email ESP', 'high', ['reader_data']);
    addStep(0, 'launch_day', 'Post launch-day social content', 'Social platforms', 'medium');
    addStep(1, 'launch_day', 'Kick off AMS ad campaigns', 'Amazon Advertising', 'high', ['financial_action']);

    // ── Post-launch follow-ups ──
    addStep(7, 'follow_up_30', 'Price pulse: launch → $4.99', 'Amazon KDP', 'high', ['financial_action']);
    addStep(14, 'follow_up_30', 'Follow-up email to engaged readers', 'Email ESP', 'medium', ['reader_data']);
    addStep(30, 'follow_up_30', 'AMS campaign review + optimization', 'Amazon Advertising', 'medium', ['financial_action']);
    addStep(60, 'follow_up_60', 'Mid-tail email + social recap', 'Email ESP', 'medium', ['reader_data']);
    addStep(90, 'follow_up_90', 'BookBub Featured Deal submission (if eligible)', 'BookBub', 'high');

    // ── Warnings ──
    if (!state.metadata.blurb) warnings.push('No blurb drafted yet — run the blurb-writer skill.');
    if (!state.metadata.keywords || state.metadata.keywords.length < 7) {
      warnings.push(`KDP requires 7 keywords; have ${state.metadata.keywords?.length ?? 0}.`);
    }
    if (!state.metadata.categories || state.metadata.categories.length < 2) {
      warnings.push(`KDP requires 2 categories; have ${state.metadata.categories?.length ?? 0}.`);
    }
    if (new Date(state.targetReleaseDate).getTime() < Date.now() + preOrderLead * 86400000) {
      warnings.push(`Release date is less than ${preOrderLead} days away — pre-order timing may be tight.`);
    }

    return { state, timeline, totalSteps: timeline.length, warnings };
  }

  /**
   * Kick off a single launch step. Does NOT execute irreversible actions
   * itself — creates a ConfirmationRequest and returns its ID. Caller
   * polls / awaits the gate before doing anything external.
   */
  async proposeStep(launchId: string, phase: LaunchPhase): Promise<{ confirmationId?: string; state: LaunchState; message: string }> {
    const state = this.states.get(launchId);
    if (!state) throw new Error('Launch not found');
    if (!this.gate || !this.disclosures) throw new Error('Launch orchestrator not fully wired (missing gate or disclosures)');

    const plan = this.buildPlan(state);
    const step = plan.timeline.find(s => s.phase === phase);
    if (!step) throw new Error(`Phase ${phase} not in the plan for this launch`);

    // Check disclosures.
    const check = this.disclosures.checkCompliance({
      platform: step.platform,
      scopes: step.disclosures,
      acknowledgedScopes: state.aiDisclosuresAcknowledged,
    });

    if (check.mustReject.length > 0) {
      return { state, message: `Action blocked by policy:\n${check.mustReject.join('\n')}` };
    }
    if (!check.passed) {
      return {
        state,
        message: `Disclosure acknowledgments required before this step:\n${check.missingAcknowledgments.join(', ')}\n\n` +
                 `Required text:\n${this.disclosures.formatForConfirmation(check.requirements).join('\n\n')}\n\n` +
                 `Acknowledge via POST /api/launches/${launchId}/acknowledge-disclosures`,
      };
    }

    // Build the dry-run diff + rollback steps depending on the action.
    const { dryRunResult, rollbackSteps } = this.buildStepPreview(step, state);
    const costEstimate = this.estimatedCostFor(step, state);
    const dryRunWithCost = `${dryRunResult}\n\nEstimated cost: $${costEstimate.usd.toFixed(2)} ` +
      `(${costEstimate.confidence === 'listed' ? 'listed' : 'rough estimate'}) — ${costEstimate.note}`;

    const req = await this.gate.createRequest({
      service: 'launch-orchestrator',
      action: `${phase}:${step.action.slice(0, 50)}`,
      platform: step.platform,
      description: `${step.action} for "${state.bookTitle}" on ${new Date(step.date).toISOString().split('T')[0]}`,
      payload: {
        launchId,
        phase,
        bookTitle: state.bookTitle,
        authorName: state.authorName,
        metadata: state.metadata,
      },
      riskLevel: step.riskLevel,
      isReversible: phase !== 'launch_day' && !step.action.includes('Publish'),
      disclosures: this.disclosures.formatForConfirmation(check.requirements),
      dryRunResult: dryRunWithCost,
      rollbackSteps,
      estimatedCost: costEstimate.usd,
    });

    // Track which confirmation this phase belongs to.
    state.phaseHistory.push({ phase, enteredAt: new Date().toISOString(), confirmationId: req.id });
    state.updatedAt = new Date().toISOString();
    await this.persist();

    return {
      confirmationId: req.id,
      state,
      message: `Confirmation request created. Review and approve in the dashboard (or via /api/confirmations/${req.id}/approve) before the action will execute.`,
    };
  }

  /**
   * Record that a step was executed (or rejected) after the gate resolves.
   * Moves the launch forward in its state machine.
   */
  async recordStepOutcome(launchId: string, phase: LaunchPhase, outcome: string): Promise<LaunchState | null> {
    const state = this.states.get(launchId);
    if (!state) return null;
    state.currentPhase = phase;
    const lastEntry = state.phaseHistory[state.phaseHistory.length - 1];
    if (lastEntry && lastEntry.phase === phase) lastEntry.outcome = outcome;
    else state.phaseHistory.push({ phase, enteredAt: new Date().toISOString(), outcome });
    state.updatedAt = new Date().toISOString();
    await this.persist();
    return state;
  }

  // ── Private helpers ──

  private buildStepPreview(step: LaunchPlan['timeline'][0], state: LaunchState): { dryRunResult: string; rollbackSteps: string } {
    const m = state.metadata;
    let dry = `Platform: ${step.platform}\nAction: ${step.action}\n\n`;
    let rollback = '';

    if (step.phase === 'pre_order_live' || step.phase === 'launch_day') {
      dry += `Book: "${state.bookTitle}" by ${state.authorName}\n`;
      dry += `Price: $${m.priceUSD ?? '(not set)'}\n`;
      dry += `Categories: ${m.categories?.join(' / ') ?? '(not set)'}\n`;
      dry += `Keywords: ${m.keywords?.join(', ') ?? '(not set)'}\n\n`;
      dry += `Blurb preview:\n${(m.blurb ?? '(not set)').slice(0, 400)}${(m.blurb?.length ?? 0) > 400 ? '…' : ''}`;
      rollback = step.phase === 'launch_day'
        ? 'KDP publish is effectively irreversible. You can unpublish within 90 days but copies already sold remain with buyers. To rollback price pulses: manually revert in KDP Bookshelf.'
        : 'Delete the pre-order from KDP Bookshelf. Readers who pre-ordered will be notified by Amazon.';
    } else if (step.phase === 'arc_seeded') {
      dry += `ARC list size: ${m.arcListSize ?? 'unknown'}\n`;
      dry += `Delivery: BookFunnel link or direct file send\n`;
      rollback = 'Cannot un-send email. Future ARC waves can be adjusted.';
    } else if (step.action.includes('AMS') || step.action.includes('ad')) {
      dry += `Initial daily budget cap applies — review in AMS before approving each campaign.\n`;
      rollback = 'Pause or stop the campaign in AMS. Spend already incurred cannot be refunded.';
    } else {
      dry += `(No dry-run preview available for this step type yet.)`;
      rollback = 'See platform documentation for rollback options.';
    }

    return { dryRunResult: dry, rollbackSteps: rollback };
  }

  /**
   * Estimate the cost of a launch step, sourced from the central pricing
   * table (pricing.ts). Every step returns SOME estimate — even if it's an
   * explicit 0 — plus a confidence tag so callers/UI can distinguish a
   * provider-listed price from a rough guess.
   */
  private estimatedCostFor(step: LaunchPlan['timeline'][0], _state: LaunchState): { usd: number; confidence: CostConfidence; note: string } {
    const haystack = `${step.action} ${step.platform}`.toLowerCase();

    const matchers: Array<{ test: RegExp; key: keyof typeof PRICING.launchSteps }> = [
      { test: /\bams\b|advertising|ad campaign|\bads?\b/, key: 'ams' },
      { test: /bookfunnel/, key: 'bookfunnel' },
      { test: /email|esp/, key: 'esp' },
      { test: /bookbub/, key: 'bookbub' },
      { test: /kdp|amazon kdp/, key: 'kdp' },
      { test: /social/, key: 'social' },
      { test: /internal/, key: 'internal' },
    ];

    const match = matchers.find(m => m.test.test(haystack));
    const entry = match ? PRICING.launchSteps[match.key] : PRICING.launchSteps.default;

    return { usd: entry.usd, confidence: entry.confidence, note: entry.note };
  }

  private async persist(): Promise<void> {
    try {
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify({ launches: Array.from(this.states.values()) }, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist launches:', err);
    }
  }
}
