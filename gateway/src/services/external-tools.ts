/**
 * AuthorAgent External Tools Bridge
 *
 * Thin wrappers around sibling Python tools in ../Automations/. These spawn
 * the tools as short-lived child processes (not via the Orchestrator's
 * long-running manager — these are one-shot transforms).
 *
 * Supported tools:
 *  - Manuscript Autopsy: pacing heatmap analyzer (Python + spaCy)
 *  - Format Pro:          manuscript → DOCX/EPUB/PDF/Markdown formatter (Python)
 *
 * If the tool isn't found on disk, the method returns a descriptive error
 * rather than throwing — lets the dashboard fall back gracefully.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve as pathResolve } from 'path';

export interface ExternalToolResult<T = any> {
  success: boolean;
  data?: T;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
}

export interface PacingHeatmap {
  chapters: Array<{
    number: number;
    wordCount: number;
    tension: number;
    pacing: 'slow' | 'good' | 'fast';
    notes?: string;
  }>;
  averageTension?: number;
  sagWindows?: Array<{ from: number; to: number; reason: string }>;
}

const DEFAULT_SEARCH_ROOTS = [
  // Relative to the AuthorAgent repo root.
  '..',
  // Common install location for the Automations folder.
  join('..', '..', 'Automations'),
  join('..', 'Automations'),
];

export class ExternalToolsService {
  private repoRoot: string;
  private pythonCommand: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    // Windows usually has `python` on PATH; Linux/macOS usually `python3`.
    this.pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  }

  /** Locate a sibling project by name, returning its root dir or null. */
  private findSiblingProject(name: string): string | null {
    const candidates = DEFAULT_SEARCH_ROOTS.map(r => pathResolve(this.repoRoot, r, name));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Run Manuscript Autopsy on a manuscript text (any length).
   * Writes text to a temp file, invokes the tool, reads the JSON output.
   */
  async runManuscriptAutopsy(manuscriptText: string): Promise<ExternalToolResult<PacingHeatmap>> {
    const projectDir = this.findSiblingProject('Manuscript Autopsy');
    if (!projectDir) {
      return { success: false, error: 'Manuscript Autopsy not found on disk. Expected at ../Automations/Manuscript Autopsy/' };
    }

    const entry = ['main.py', 'autopsy.py', 'cli.py']
      .map(f => join(projectDir, f))
      .find(p => existsSync(p));
    if (!entry) {
      return { success: false, error: `Manuscript Autopsy entry script not found in ${projectDir}. Expected main.py/autopsy.py/cli.py.` };
    }

    const tmpDir = join(this.repoRoot, 'workspace', 'tmp', 'autopsy');
    await mkdir(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, `input-${Date.now()}.txt`);
    const outputPath = join(tmpDir, `output-${Date.now()}.json`);
    await writeFile(inputPath, manuscriptText, 'utf-8');

    const result = await this.runProcess(
      this.pythonCommand,
      [entry, '--input', inputPath, '--json-out', outputPath],
      projectDir,
      120000, // 2 min
    );

    if (!result.success) return result;

    // Try to read the JSON output; if the tool doesn't accept --json-out yet,
    // surface stdout as-is so the dashboard can display it raw.
    if (existsSync(outputPath)) {
      try {
        const raw = await readFile(outputPath, 'utf-8');
        const data: PacingHeatmap = JSON.parse(raw);
        return { ...result, data };
      } catch (err: any) {
        return { ...result, error: `Could not parse JSON output: ${err?.message || err}` };
      }
    }

    return { ...result, error: 'Autopsy ran but did not produce the expected JSON output. The tool may need a --json-out flag.' };
  }

  /**
   * Run Format Pro to produce a publication-ready export.
   * Returns the path to the output file.
   */
  async runFormatPro(params: {
    manuscriptPath: string;          // Absolute path to .md/.docx source
    outputFormat: 'docx' | 'epub' | 'pdf' | 'md';
    title: string;
    author: string;
    trimSize?: string;                // "6x9", "5x8", etc. (for print)
  }): Promise<ExternalToolResult<{ outputPath: string }>> {
    const projectDir = this.findSiblingProject('Format Pro');
    if (!projectDir) {
      return { success: false, error: 'Format Pro not found on disk. Expected at ../Automations/Format Pro/' };
    }

    const entry = ['cli.py', 'format.py', 'gui_app.py', 'main.py']
      .map(f => join(projectDir, f))
      .find(p => existsSync(p));
    if (!entry) {
      return { success: false, error: `Format Pro entry script not found in ${projectDir}.` };
    }

    const tmpDir = join(this.repoRoot, 'workspace', 'tmp', 'format-pro');
    await mkdir(tmpDir, { recursive: true });
    const outputPath = join(tmpDir, `${params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${params.outputFormat}`);

    const args = [
      entry,
      '--input', params.manuscriptPath,
      '--output', outputPath,
      '--format', params.outputFormat,
      '--title', params.title,
      '--author', params.author,
    ];
    if (params.trimSize) args.push('--trim', params.trimSize);

    const result = await this.runProcess(this.pythonCommand, args, projectDir, 180000);

    if (!result.success) return result;
    if (!existsSync(outputPath)) {
      return { ...result, error: 'Format Pro ran but did not produce the expected output file.' };
    }

    return { ...result, data: { outputPath } };
  }

  /** Spawn a child process and capture stdout/stderr. Returns on exit or timeout. */
  private runProcess(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<ExternalToolResult> {
    return new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const proc = spawn(cmd, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      const timeout = setTimeout(() => {
        if (!settled) {
          try { proc.kill('SIGKILL'); } catch { /* noop */ }
          settled = true;
          resolve({ success: false, error: `Process timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
      proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ success: false, error: `Spawn failed: ${err.message}` });
      });

      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        resolve({
          success: code === 0,
          exitCode: code ?? -1,
          stdout,
          stderr,
          error: code === 0 ? undefined : `Process exited with code ${code}: ${stderr.slice(0, 500)}`,
        });
      });
    });
  }
}
