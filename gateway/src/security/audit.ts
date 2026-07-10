/**
 * AuthorAgent Audit Log
 * Tamper-resistant logging of all agent actions
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

export class AuditLog {
  private logDir: string;
  private lastHash = '0';

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  async initialize(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
  }

  async log(category: string, action: string, data: Record<string, any>): Promise<void> {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      action,
      data,
      previousHash: this.lastHash,
    };

    // Chain hashes for tamper detection
    const entryStr = JSON.stringify(entry);
    this.lastHash = createHash('sha256').update(entryStr).digest('hex').substring(0, 16);

    const logLine = JSON.stringify({ ...entry, hash: this.lastHash }) + '\n';
    const logFile = join(this.logDir, `${new Date().toISOString().split('T')[0]}.jsonl`);

    await appendFile(logFile, logLine);
  }
}
