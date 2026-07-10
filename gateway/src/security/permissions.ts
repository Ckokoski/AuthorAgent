/**
 * AuthorAgent Permission Manager
 * Capability-based access control with 4 presets
 */

export type PermissionPreset = 'minimal' | 'standard' | 'advanced' | 'expert';

interface PermissionSet {
  shell: boolean;
  shellSandboxed: boolean;
  browser: boolean;
  browserAllowlist: boolean;
  filesWorkspaceOnly: boolean;
  filesHomeDir: boolean;
  filesFullAccess: boolean;
  network: boolean;
  selfModify: boolean;
  deleteFiles: boolean;
  exportFiles: boolean;
  researchInternet: boolean;
}

const PRESETS: Record<PermissionPreset, PermissionSet> = {
  minimal: {
    shell: false, shellSandboxed: false,
    browser: false, browserAllowlist: false,
    filesWorkspaceOnly: true, filesHomeDir: false, filesFullAccess: false,
    network: false, selfModify: false, deleteFiles: false,
    exportFiles: true, researchInternet: false,
  },
  standard: {
    shell: false, shellSandboxed: true,
    browser: false, browserAllowlist: true,
    filesWorkspaceOnly: true, filesHomeDir: false, filesFullAccess: false,
    network: true, selfModify: false, deleteFiles: false,
    exportFiles: true, researchInternet: true,
  },
  advanced: {
    shell: false, shellSandboxed: true,
    browser: true, browserAllowlist: true,
    filesWorkspaceOnly: false, filesHomeDir: true, filesFullAccess: false,
    network: true, selfModify: false, deleteFiles: true,
    exportFiles: true, researchInternet: true,
  },
  expert: {
    shell: true, shellSandboxed: false,
    browser: true, browserAllowlist: false,
    filesWorkspaceOnly: false, filesHomeDir: false, filesFullAccess: true,
    network: true, selfModify: true, deleteFiles: true,
    exportFiles: true, researchInternet: true,
  },
};

export class PermissionManager {
  preset: PermissionPreset;
  private permissions: PermissionSet;
  private rateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private maxPerMinute = 30;

  constructor(preset: PermissionPreset = 'standard') {
    this.preset = preset;
    this.permissions = { ...PRESETS[preset] };
  }

  check(permission: keyof PermissionSet): boolean {
    return this.permissions[permission] ?? false;
  }

  checkRateLimit(channel: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(channel);

    if (!entry || entry.resetAt < now) {
      this.rateLimits.set(channel, { count: 1, resetAt: now + 60000 });
      return true;
    }

    entry.count++;
    return entry.count <= this.maxPerMinute;
  }
}
