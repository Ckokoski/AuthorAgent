/**
 * AuthorClaw Confirmation Gate
 *
 * Universal safety rail. EVERY irreversible action in Wave 3 (publish, send,
 * submit, purchase, bid change, delete, upload-to-store) must create a
 * ConfirmationRequest here, and the caller must NOT execute until the user
 * explicitly approves it in the dashboard.
 *
 * Architecture:
 *   1. Worker service calls `createRequest()` with a full description of what
 *      it's about to do. Gets back a requestId, sets status 'pending'.
 *   2. User sees the request in the dashboard (via GET /api/confirmations).
 *      The card shows: action, target platform, payload preview, dry-run diff,
 *      legal disclosures, rollback steps.
 *   3. User clicks Approve or Reject. Worker polls (or gets notified) and
 *      only proceeds if approved.
 *   4. After execution, worker calls `recordOutcome()` with success/failure
 *      and any audit metadata. Request transitions to 'completed' or 'failed'.
 *
 * Hard rules enforced by this service:
 *   - No auto-approval. Ever. Confirmations expire unreviewed after 24h.
 *   - No "approve all" — every action is its own request.
 *   - Rejected requests are final; the worker cannot retry without creating
 *     a new request.
 *   - Every state transition is written to the audit log.
 *   - Requests that claim they're "already authorized" or "pre-approved" via
 *     their metadata are rejected at creation time.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ConfirmationStatus =
  | 'pending'     // Awaiting user decision
  | 'approved'    // User said yes; worker should execute
  | 'rejected'    // User said no; worker must not execute
  | 'completed'   // Worker executed successfully
  | 'failed'      // Worker executed but failed
  | 'expired';    // 24h passed with no decision

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ConfirmationRequest {
  id: string;
  createdAt: string;
  expiresAt: string;

  // What's about to happen
  service: string;              // "launch-orchestrator", "ams-ads", etc.
  action: string;               // "publish-to-kdp", "create-ad-campaign", etc.
  platform: string;             // "Amazon KDP", "BookBub", "MailerLite", ...
  description: string;          // Human-readable summary

  // Full payload the worker will send (for review)
  payload: Record<string, any>;
  dryRunResult?: string;        // Preview of what would happen
  rollbackSteps?: string;       // If executed, how to undo

  // Safety metadata
  riskLevel: RiskLevel;
  isReversible: boolean;
  disclosures: string[];        // Required legal/platform disclosures
  estimatedCost?: number;       // USD if financial

  // State machine
  status: ConfirmationStatus;
  decidedAt?: string;
  decidedBy?: string;           // Currently always "user" — single-user system
  outcome?: {
    success: boolean;
    message: string;
    externalId?: string;        // Platform-assigned ID (e.g., ASIN, campaign ID)
    executedAt: string;
    metadata?: Record<string, any>;
  };
}

export interface CreateConfirmationInput {
  service: string;
  action: string;
  platform: string;
  description: string;
  payload: Record<string, any>;
  riskLevel: RiskLevel;
  isReversible: boolean;
  disclosures?: string[];
  dryRunResult?: string;
  rollbackSteps?: string;
  estimatedCost?: number;
}

type AuditFn = (category: string, action: string, metadata: Record<string, any>) => Promise<void> | void;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_STORED_REQUESTS = 1000;               // Ring-buffer cap

export class ConfirmationGateService {
  private requests: Map<string, ConfirmationRequest> = new Map();
  private filePath: string;
  private auditFn: AuditFn | null = null;
  private expiryMs: number;

  constructor(workspaceDir: string, expiryMs: number = DEFAULT_EXPIRY_MS) {
    this.filePath = join(workspaceDir, 'confirmations.json');
    this.expiryMs = expiryMs;
  }

  setAuditLogger(fn: AuditFn): void {
    this.auditFn = fn;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (existsSync(this.filePath)) {
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const arr: ConfirmationRequest[] = Array.isArray(parsed.requests) ? parsed.requests : [];
        for (const r of arr) this.requests.set(r.id, r);
      } catch {
        this.requests = new Map();
      }
    }
    // Sweep any expired pending requests on startup.
    this.sweepExpired();
  }

  /**
   * Create a new confirmation request. The calling service MUST await a
   * subsequent 'approved' status via polling / awaitDecision() before
   * executing any irreversible side effect.
   */
  async createRequest(input: CreateConfirmationInput): Promise<ConfirmationRequest> {
    // Defense: reject requests whose payload claims pre-authorization. These
    // usually come from injected content (emails, scraped text, form fields)
    // trying to bypass the user gate.
    if (this.payloadClaimsPreAuth(input.payload) || this.payloadClaimsPreAuth(input.description)) {
      throw new Error('Confirmation request rejected: payload contains pre-authorization claims. User must approve every action explicitly in the dashboard.');
    }

    const now = new Date();
    const req: ConfirmationRequest = {
      id: `conf-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.expiryMs).toISOString(),
      service: input.service,
      action: input.action,
      platform: input.platform,
      description: input.description,
      payload: this.sanitizePayload(input.payload),
      dryRunResult: input.dryRunResult,
      rollbackSteps: input.rollbackSteps,
      riskLevel: input.riskLevel,
      isReversible: input.isReversible,
      disclosures: input.disclosures || [],
      estimatedCost: input.estimatedCost,
      status: 'pending',
    };

    this.requests.set(req.id, req);
    await this.enforceCap();
    await this.persist();
    await this.audit('confirmation', 'created', {
      id: req.id, service: req.service, action: req.action,
      platform: req.platform, risk: req.riskLevel,
    });
    return req;
  }

  /** List requests, newest first. */
  list(filter?: { status?: ConfirmationStatus; service?: string }): ConfirmationRequest[] {
    this.sweepExpired();
    let list = Array.from(this.requests.values());
    if (filter?.status) list = list.filter(r => r.status === filter.status);
    if (filter?.service) list = list.filter(r => r.service === filter.service);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ConfirmationRequest | undefined {
    const req = this.requests.get(id);
    if (req && this.isExpired(req)) this.expireOne(req);
    return this.requests.get(id);
  }

  /**
   * User approval. Reachable ONLY via POST /api/confirmations/:id/approve,
   * which sits behind the bearer-auth gate (and the optional source-IP
   * allowlist) on /api/* — see gateway/src/index.ts. No bridge or WebSocket
   * approval path exists, by design, so observed/injected content cannot reach
   * this method. NOTE: the server no longer binds to loopback only (bind
   * defaults to 0.0.0.0 for LAN/Docker), so the bearer token — not the bind
   * address — is the trust boundary. Never expose approval on an
   * unauthenticated route or a non-HTTP channel.
   */
  async approve(id: string, decidedBy: string = 'user'): Promise<ConfirmationRequest | null> {
    const req = this.requests.get(id);
    if (!req) return null;
    if (req.status !== 'pending') {
      throw new Error(`Cannot approve: request is ${req.status}`);
    }
    if (this.isExpired(req)) {
      this.expireOne(req);
      throw new Error('Cannot approve: request has expired');
    }
    req.status = 'approved';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    await this.persist();
    await this.audit('confirmation', 'approved', { id: req.id, service: req.service, action: req.action });
    return req;
  }

  async reject(id: string, decidedBy: string = 'user', reason?: string): Promise<ConfirmationRequest | null> {
    const req = this.requests.get(id);
    if (!req) return null;
    if (req.status !== 'pending') {
      throw new Error(`Cannot reject: request is ${req.status}`);
    }
    req.status = 'rejected';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    if (reason) req.outcome = { success: false, message: `Rejected: ${reason}`, executedAt: req.decidedAt };
    await this.persist();
    await this.audit('confirmation', 'rejected', { id: req.id, reason });
    return req;
  }

  /**
   * Called by the worker after executing an approved request.
   * Transitions the request to 'completed' or 'failed'.
   */
  async recordOutcome(id: string, outcome: ConfirmationRequest['outcome']): Promise<ConfirmationRequest | null> {
    const req = this.requests.get(id);
    if (!req) return null;
    if (req.status !== 'approved') {
      throw new Error(`Cannot record outcome: request is ${req.status}, expected 'approved'.`);
    }
    if (!outcome) throw new Error('Outcome required');
    req.outcome = outcome;
    req.status = outcome.success ? 'completed' : 'failed';
    await this.persist();
    await this.audit('confirmation', outcome.success ? 'completed' : 'failed', {
      id: req.id, service: req.service, externalId: outcome.externalId,
    });
    return req;
  }

  /**
   * Synchronous polling helper for workers. Checks if approved/rejected.
   * Call periodically, respecting the user's pace.
   */
  checkDecision(id: string): { status: ConfirmationStatus; request: ConfirmationRequest | null } {
    const req = this.get(id);
    return { status: req?.status ?? 'expired', request: req ?? null };
  }

  /** Async helper: poll every `intervalMs` until a terminal state or timeout. */
  async awaitDecision(
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<ConfirmationRequest> {
    const interval = opts.intervalMs ?? 5000;
    const timeout = opts.timeoutMs ?? this.expiryMs;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const req = this.get(id);
      if (!req) throw new Error('Request not found');
      if (req.status === 'approved' || req.status === 'rejected' || req.status === 'expired'
          || req.status === 'completed' || req.status === 'failed') {
        return req;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('Timed out waiting for user decision');
  }

  // ── Private ──

  /**
   * Detect pre-authorization bypass attempts in payloads / descriptions.
   * These phrases are a red flag that something in observed content is
   * trying to trick the user into believing the action is already approved.
   */
  private payloadClaimsPreAuth(obj: any): boolean {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
    const suspicious = [
      /pre[-_\s]?authorized/i,
      /already\s+approved/i,
      /user\s+has\s+authorized/i,
      /auto[-_\s]?(approve|submit|send)/i,
      /bypass\s+confirmation/i,
      /skip\s+(gate|confirmation|approval)/i,
    ];
    return suspicious.some(r => r.test(str));
  }

  /** Redact API keys / bearer tokens from persisted payloads. */
  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const SENSITIVE = /api[_-]?key|secret|password|credential|bearer|auth[_-]?token|access[_-]?token|sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35}/i;
    const walk = (v: any): any => {
      if (v === null || v === undefined) return v;
      if (typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE.test(k)) out[k] = '[REDACTED]';
        else if (typeof val === 'string' && SENSITIVE.test(val)) out[k] = '[REDACTED]';
        else out[k] = walk(val);
      }
      return out;
    };
    return walk(payload);
  }

  private isExpired(req: ConfirmationRequest): boolean {
    return req.status === 'pending' && new Date(req.expiresAt).getTime() < Date.now();
  }

  private expireOne(req: ConfirmationRequest): void {
    if (req.status !== 'pending') return;
    req.status = 'expired';
    this.persist().catch(() => {});
    this.audit('confirmation', 'expired', { id: req.id }).catch(() => {});
  }

  private sweepExpired(): void {
    for (const req of this.requests.values()) {
      if (this.isExpired(req)) this.expireOne(req);
    }
  }

  /** Keep the store bounded — drop oldest completed/rejected/expired. */
  private async enforceCap(): Promise<void> {
    if (this.requests.size <= MAX_STORED_REQUESTS) return;
    const dropCandidates = Array.from(this.requests.values())
      .filter(r => r.status !== 'pending' && r.status !== 'approved')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const toDrop = this.requests.size - MAX_STORED_REQUESTS;
    for (let i = 0; i < toDrop && i < dropCandidates.length; i++) {
      this.requests.delete(dropCandidates[i].id);
    }
  }

  private async persist(): Promise<void> {
    try {
      const tmp = this.filePath + '.tmp';
      const data = JSON.stringify({ requests: Array.from(this.requests.values()) }, null, 2);
      await writeFile(tmp, data, 'utf-8');
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist confirmations:', err);
    }
  }

  private async audit(category: string, action: string, meta: Record<string, any>): Promise<void> {
    try {
      await this.auditFn?.(category, action, meta);
    } catch { /* non-fatal */ }
  }
}
