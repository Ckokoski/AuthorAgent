/**
 * AuthorAgent Sandbox Guard
 * Constrains all file operations to the workspace directory.
 *
 * Thin wrapper around security/paths.ts — the robust path-safety logic lives
 * there and is shared with api/routes.ts and services/memory.ts. This class
 * keeps its historical public surface (validatePath / sanitizeFilename) plus a
 * forbidden-pattern layer specific to the sandbox.
 */

import { resolve } from 'path';
import { safeResolveWithin, sanitizeSegment } from './paths.js';

export class SandboxGuard {
  private workspaceRoot: string;
  private forbiddenPatterns = [
    /\.\.\//, /\.\.\\/, // path traversal
    /\/etc\//, /\/proc\//, /\/sys\//, // system dirs
    /~\/\.ssh/, /~\/\.gnupg/, // sensitive dirs
    /\.env$/, /\.vault/, // sensitive files
    /node_modules/, // dependency dirs
  ];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /**
   * Validate that a path is within the workspace.
   * Delegates boundary/traversal checking to resolveWithin, then applies the
   * sandbox-specific forbidden-pattern denylist.
   */
  validatePath(targetPath: string): { valid: boolean; reason?: string; resolved?: string } {
    const resolved = safeResolveWithin(this.workspaceRoot, targetPath);
    if (!resolved) {
      return { valid: false, reason: 'Path escapes workspace boundary' };
    }

    // Check forbidden patterns against both the raw input and resolved path.
    for (const pattern of this.forbiddenPatterns) {
      if (pattern.test(targetPath) || pattern.test(resolved)) {
        return { valid: false, reason: `Path matches forbidden pattern: ${pattern}` };
      }
    }

    return { valid: true, resolved };
  }

  /**
   * Sanitize a filename to a safe single path segment.
   */
  sanitizeFilename(name: string): string {
    return sanitizeSegment(name, 'file');
  }
}
