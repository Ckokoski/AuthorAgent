/**
 * AuthorAgent Orchestrator Service
 * Manages user scripts/processes — start/stop/restart, health monitoring,
 * log capture, auto-restart on crash, config persistence.
 *
 * Lightweight PM2-like process manager built into AuthorAgent.
 * Ported from Sneakers.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface ScriptConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  autoStart: boolean;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  tags: string[];
}

export interface ScriptStatus {
  id: string;
  name: string;
  state: 'running' | 'stopped' | 'crashed' | 'restarting';
  pid: number | null;
  uptime: number | null;
  startedAt: string | null;
  restartCount: number;
  lastError: string | null;
  exitCode: number | null;
  tags: string[];
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/** Build a safe environment that doesn't leak sensitive vars */
function buildSafeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Redact sensitive keys
  const sensitiveKeys = [
    'AUTHORCLAW_VAULT_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY',
    'ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY',
  ];
  for (const key of sensitiveKeys) {
    delete env[key];
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

/**
 * Pre-execution command scan — inspired by Hermes Agent's Tirith pattern.
 * Returns a list of warnings if the command looks dangerous. The
 * orchestrator uses this to BLOCK obviously-destructive commands and
 * REQUIRE explicit acknowledgment for borderline ones.
 *
 * This is a defense-in-depth layer, not a sandbox replacement.
 */
export interface CommandScanResult {
  /** True = command is BLOCKED outright. */
  blocked: boolean;
  /** Warnings the user should review even if not blocked. */
  warnings: string[];
  /** The pattern that matched (for audit logging). */
  matched?: string;
}

const HARD_BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-rf?\s+(\/|~|\$HOME|\$\{HOME\}|\.\.)/i, reason: 'rm -rf against root, home, or parent — almost certainly destructive' },
  { re: /\bdd\s+if=.+of=\/dev\//i, reason: 'dd writing to a raw device — disk-wiping pattern' },
  { re: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem format command' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork-bomb' },
  { re: /\bcurl\s+[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i, reason: 'curl-piped-to-shell — never run remote scripts blind' },
  { re: /\bwget\s+[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i, reason: 'wget-piped-to-shell — never run remote scripts blind' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'system shutdown / reboot' },
  { re: /\bchmod\s+(?:-R\s+)?(?:777|0?777)\s+(?:\/|~)/i, reason: 'chmod 777 on root/home — dangerous permission change' },
  { re: />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+)\b/i, reason: 'redirecting output to a raw disk device' },
];

const WARN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b/i, reason: 'sudo — script will request elevated privileges' },
  { re: /\bcurl\s/i, reason: 'curl — network request; verify the URL is what you expect' },
  { re: /\bwget\s/i, reason: 'wget — network request' },
  { re: /\bgit\s+(?:reset\s+--hard|push\s+--force|clean\s+-f)/i, reason: 'destructive git operation' },
  { re: /\bnpm\s+(?:install|add|i)\s+-g\b/i, reason: 'global npm install — affects system-wide Node' },
  { re: /\bpip\s+install/i, reason: 'pip install — Python package install' },
];

export function scanCommand(command: string, args: string[] = []): CommandScanResult {
  // Combine command + args into a single string for pattern matching.
  // ManagedScript runs with shell:true on Windows so the user's command
  // string can already contain shell metacharacters — scan the joined form.
  const full = [command, ...args].join(' ');
  const warnings: string[] = [];

  for (const { re, reason } of HARD_BLOCK_PATTERNS) {
    if (re.test(full)) {
      return { blocked: true, warnings: [reason], matched: re.source };
    }
  }

  for (const { re, reason } of WARN_PATTERNS) {
    if (re.test(full)) warnings.push(reason);
  }

  return { blocked: false, warnings };
}

// ═══════════════════════════════════════════════════════════
// Ring Buffer — fixed-size log storage
// ═══════════════════════════════════════════════════════════

class RingBuffer {
  private buffer: string[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getLast(count: number): string[] {
    return this.buffer.slice(-count);
  }
}

// ═══════════════════════════════════════════════════════════
// ManagedScript — wraps a single child process
// ═══════════════════════════════════════════════════════════

class ManagedScript {
  config: ScriptConfig;
  private process: ChildProcess | null = null;
  private logs: RingBuffer = new RingBuffer(500);
  private _state: ScriptStatus['state'] = 'stopped';
  private _startedAt: Date | null = null;
  private _restartCount = 0;
  private _lastError: string | null = null;
  private _exitCode: number | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private emitter: EventEmitter;
  private stopping = false;

  constructor(config: ScriptConfig, emitter: EventEmitter) {
    this.config = config;
    this.emitter = emitter;
  }

  start(): void {
    if (this._state === 'running') return;

    this.stopping = false;
    this._lastError = null;
    this._exitCode = null;

    // Pre-execution command scan (Hermes-inspired Tirith pattern).
    // Hard-blocks destructive commands (rm -rf /, dd of=/dev/sda, fork-bombs,
    // curl|sh) and warns on borderline ones (sudo, --force pushes, etc.).
    const scan = scanCommand(this.config.command, this.config.args);
    if (scan.blocked) {
      const reason = `Pre-execution scan BLOCKED command: ${scan.warnings.join('; ')}`;
      this._lastError = reason;
      this._state = 'crashed';
      this.logs.push(`[system] ${reason}`);
      this.logs.push(`[system] Pattern matched: ${scan.matched}`);
      this.logs.push(`[system] To run this anyway, edit the command in the dashboard or via /api/orchestrator/scripts.`);
      this.emitter.emit('script-crashed', {
        id: this.config.id, error: reason, restartCount: this._restartCount, blocked: true,
      });
      return;
    }
    if (scan.warnings.length > 0) {
      // Non-blocking warnings — surface in the log so the user sees them in
      // the dashboard logs panel.
      for (const w of scan.warnings) this.logs.push(`[scan-warn] ${w}`);
    }

    try {
      this.process = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd || undefined,
        env: buildSafeEnv(this.config.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      this._state = 'running';
      this._startedAt = new Date();

      const pid = this.process.pid ?? null;
      this.emitter.emit('script-started', { id: this.config.id, pid });

      this.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(l => l.length > 0);
        for (const line of lines) this.logs.push(`[stdout] ${line}`);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(l => l.length > 0);
        for (const line of lines) this.logs.push(`[stderr] ${line}`);
      });

      this.process.on('exit', (code, signal) => {
        this._exitCode = code;
        this.process = null;

        if (this.stopping) {
          this._state = 'stopped';
          this.emitter.emit('script-stopped', { id: this.config.id, exitCode: code });
          return;
        }

        this._lastError = signal
          ? `Killed by signal ${signal}`
          : `Exited with code ${code}`;
        this.logs.push(`[system] Process exited: ${this._lastError}`);

        if (this.config.autoRestart && this._restartCount < this.config.maxRestarts) {
          this._state = 'restarting';
          this._restartCount++;
          this.emitter.emit('script-crashed', {
            id: this.config.id, error: this._lastError, restartCount: this._restartCount,
          });

          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start();
          }, this.config.restartDelayMs);
        } else {
          this._state = 'crashed';
          this.emitter.emit('script-crashed', {
            id: this.config.id, error: this._lastError, restartCount: this._restartCount,
          });
        }
      });

      this.process.on('error', (err) => {
        this._lastError = err.message;
        this._state = 'crashed';
        this.process = null;
        this.logs.push(`[system] Spawn error: ${err.message}`);
      });
    } catch (err) {
      this._lastError = String(err);
      this._state = 'crashed';
      this.logs.push(`[system] Failed to start: ${this._lastError}`);
    }
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      this._state = 'stopped';
      return;
    }

    this.stopping = true;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { this.process?.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);

      this.process!.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        if (process.platform === 'win32') {
          this.process!.kill();
        } else {
          this.process!.kill('SIGTERM');
        }
      } catch {
        clearTimeout(killTimer);
        this._state = 'stopped';
        this.process = null;
        resolve();
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this._restartCount = 0;
    this.start();
  }

  getStatus(): ScriptStatus {
    return {
      id: this.config.id,
      name: this.config.name,
      state: this._state,
      pid: this.process?.pid ?? null,
      uptime: this._startedAt && this._state === 'running'
        ? Date.now() - this._startedAt.getTime()
        : null,
      startedAt: this._startedAt?.toISOString() ?? null,
      restartCount: this._restartCount,
      lastError: this._lastError,
      exitCode: this._exitCode,
      tags: this.config.tags,
    };
  }

  getLogs(count = 50): string[] {
    return this.logs.getLast(count);
  }

  isHealthy(): boolean {
    if (this._state !== 'running' || !this.process?.pid) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Orchestrator Service
// ═══════════════════════════════════════════════════════════

export class OrchestratorService extends EventEmitter {
  private scripts: Map<string, ManagedScript> = new Map();
  private configs: ScriptConfig[] = [];
  private configPath: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    super();
    this.configPath = join(workspaceDir, 'orchestrator.json');
  }

  async initialize(): Promise<void> {
    if (existsSync(this.configPath)) {
      try {
        const raw = await readFile(this.configPath, 'utf-8');
        const data = JSON.parse(raw);
        this.configs = data.scripts || [];
      } catch (err) {
        console.error('  ✗ Failed to load orchestrator config:', err);
        this.configs = [];
      }
    }

    for (const config of this.configs) {
      this.scripts.set(config.id, new ManagedScript(config, this));
    }
  }

  async autoStartAll(): Promise<void> {
    for (const config of this.configs.filter(c => c.autoStart)) {
      const script = this.scripts.get(config.id);
      if (script) {
        script.start();
        console.log(`  ✓ Auto-started script: ${config.name}`);
      }
    }
  }

  // ── Script CRUD ──

  async addScript(config: Partial<ScriptConfig> & { id: string; name: string; command: string }): Promise<ScriptConfig> {
    if (this.scripts.has(config.id)) {
      throw new Error(`Script with ID "${config.id}" already exists`);
    }

    const fullConfig: ScriptConfig = {
      args: [],
      autoStart: false,
      autoRestart: true,
      maxRestarts: 5,
      restartDelayMs: 5000,
      tags: [],
      env: {},
      ...config,
    };

    this.configs.push(fullConfig);
    this.scripts.set(fullConfig.id, new ManagedScript(fullConfig, this));
    await this.debouncedPersist();
    return fullConfig;
  }

  async removeScript(id: string): Promise<boolean> {
    const script = this.scripts.get(id);
    if (!script) return false;

    await script.stop();
    this.scripts.delete(id);
    this.configs = this.configs.filter(c => c.id !== id);
    await this.debouncedPersist();
    return true;
  }

  // ── Script Control ──

  startScript(id: string): ScriptStatus | null {
    const script = this.scripts.get(id);
    if (!script) return null;
    script.start();
    return script.getStatus();
  }

  async stopScript(id: string): Promise<ScriptStatus | null> {
    const script = this.scripts.get(id);
    if (!script) return null;
    await script.stop();
    return script.getStatus();
  }

  async restartScript(id: string): Promise<ScriptStatus | null> {
    const script = this.scripts.get(id);
    if (!script) return null;
    await script.restart();
    return script.getStatus();
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.scripts.values()).map(s => s.stop()));
  }

  // ── Status & Logs ──

  getStatus(id?: string): ScriptStatus[] {
    if (id) {
      const script = this.scripts.get(id);
      return script ? [script.getStatus()] : [];
    }
    return Array.from(this.scripts.values()).map(s => s.getStatus());
  }

  getLogs(id: string, count = 50): string[] {
    const script = this.scripts.get(id);
    return script ? script.getLogs(count) : [];
  }

  getConfigs(): ScriptConfig[] {
    return [...this.configs];
  }

  // ── Health Monitoring ──

  startHealthCheck(intervalMs = 30000): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      for (const script of this.scripts.values()) {
        const status = script.getStatus();
        if (status.state === 'running' && !script.isHealthy()) {
          script.start();
        }
      }
    }, intervalMs);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    this.stopHealthCheck();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.stopAll();
    await this.persistConfig();
  }

  // ── Persistence ──

  private async debouncedPersist(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    return new Promise<void>((resolve) => {
      this.persistTimer = setTimeout(async () => {
        this.persistTimer = null;
        await this.persistConfig();
        resolve();
      }, 2000);
    });
  }

  private async persistConfig(): Promise<void> {
    try {
      const dir = join(this.configPath, '..');
      await mkdir(dir, { recursive: true });
      await writeFile(this.configPath, JSON.stringify({ scripts: this.configs }, null, 2), 'utf-8');
    } catch (err) {
      console.error('  ✗ Failed to persist orchestrator config:', err);
    }
  }
}
