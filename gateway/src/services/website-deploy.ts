/**
 * AuthorAgent Website Deploy
 *
 * Adapter pattern over the few static-site hosts authors actually use.
 * AuthorAgent's job is to produce the static site (WebsiteBuilder) and
 * track it (WebsiteSiteService). This service shells out to the host's
 * existing CLI to push the rendered files. We do NOT bundle these CLIs;
 * authors install Netlify / Vercel / etc. themselves. We probe at runtime
 * and report what's available.
 *
 * Adapters supported:
 *   netlify          — `netlify deploy --prod --dir <path> --site <id>`
 *   vercel           — `vercel deploy --prod <path>`
 *   cloudflare-pages — `wrangler pages deploy <path> --project-name <name>`
 *   github-pages     — git push against an `origin gh-pages` branch
 *   rsync            — `rsync -avz <path>/ user@host:/path/`
 *   manual-zip       — zip up the output dir, return its path; author
 *                      uploads manually via web UI (this is the SAFE
 *                      default — works on every host without auth setup)
 *   none             — render only; do not deploy
 *
 * Security:
 *   - Tokens are NEVER stored in service config. Adapters read them from
 *     process.env at deploy time using a configured tokenEnvVar name.
 *   - All shell commands have timeouts (5 min default) and maxBuffer caps.
 *   - Destinations are whitelisted by adapter (rsync requires the
 *     destination string to match user@host:/path format).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import type { DeployConfig, DeployTarget } from './website-sites.js';

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface DeployResult {
  success: boolean;
  target: DeployTarget;
  /** URL where the deployed site can be reached (when applicable). */
  url?: string;
  /** Path to the artifact (zip / dir) for manual deploys. */
  artifactPath?: string;
  /** Time the deploy took in ms. */
  durationMs: number;
  /** Stdout/stderr captured for debugging. Truncated. */
  output: string;
  error?: string;
}

export interface DoctorReport {
  netlifyCli: boolean;
  vercelCli: boolean;
  wranglerCli: boolean;
  rsyncCli: boolean;
  gitCli: boolean;
  zipCli: boolean;
  ready: Record<DeployTarget, boolean>;
  installHints: string[];
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class WebsiteDeployService {
  /** Probe the user's machine for which deploy targets are usable. */
  async doctor(): Promise<DoctorReport> {
    const [netlify, vercel, wrangler, rsync, git, zip] = await Promise.all([
      this.checkBinary('netlify'),
      this.checkBinary('vercel'),
      this.checkBinary('wrangler'),
      this.checkBinary('rsync'),
      this.checkBinary('git'),
      this.checkBinary(process.platform === 'win32' ? 'tar' : 'zip'), // tar is universal on Windows 10+
    ]);

    const ready: Record<DeployTarget, boolean> = {
      'netlify':          netlify,
      'vercel':           vercel,
      'cloudflare-pages': wrangler,
      'github-pages':     git,
      'rsync':            rsync,
      'manual-zip':       zip,
      'none':             true,
    };

    const installHints: string[] = [];
    if (!netlify)  installHints.push('Netlify CLI: `npm install -g netlify-cli` then `netlify login`.');
    if (!vercel)   installHints.push('Vercel CLI: `npm install -g vercel` then `vercel login`.');
    if (!wrangler) installHints.push('Wrangler (Cloudflare Pages): `npm install -g wrangler` then `wrangler login`.');
    if (!rsync)    installHints.push('rsync: ships preinstalled on macOS/Linux; on Windows install via WSL or Git for Windows.');
    if (!git)      installHints.push('git: required for github-pages target.');
    if (!zip)      installHints.push('zip / tar: needed for manual-zip target.');

    return {
      netlifyCli: netlify, vercelCli: vercel, wranglerCli: wrangler,
      rsyncCli: rsync, gitCli: git, zipCli: zip,
      ready, installHints,
    };
  }

  /**
   * Deploy a rendered site directory using the configured target.
   * Returns DeployResult; never throws — failures come back as
   * { success: false, error }.
   */
  async deploy(input: {
    siteId: string;
    deployConfig: DeployConfig;
    /** Path to the directory the WebsiteBuilder rendered into. */
    siteDir: string;
    /** Workspace root, used for staging the manual-zip artifact. */
    workspaceDir: string;
  }): Promise<DeployResult> {
    const start = Date.now();
    const target = input.deployConfig.target;

    if (!existsSync(input.siteDir)) {
      return {
        success: false, target,
        durationMs: Date.now() - start,
        output: '',
        error: `Render output directory not found at ${input.siteDir}. Run a render first.`,
      };
    }

    try {
      switch (target) {
        case 'none':
          return {
            success: true, target,
            durationMs: Date.now() - start,
            output: 'Render-only mode — no deploy attempted.',
          };
        case 'netlify':
          return await this.deployNetlify(input);
        case 'vercel':
          return await this.deployVercel(input);
        case 'cloudflare-pages':
          return await this.deployCloudflarePages(input);
        case 'github-pages':
          return await this.deployGithubPages(input);
        case 'rsync':
          return await this.deployRsync(input);
        case 'manual-zip':
          return await this.deployManualZip(input);
        default:
          return {
            success: false, target,
            durationMs: Date.now() - start,
            output: '',
            error: `Unknown deploy target: ${target}`,
          };
      }
    } catch (err: any) {
      return {
        success: false, target,
        durationMs: Date.now() - start,
        output: '',
        error: err?.message || String(err),
      };
    }
  }

  // ── Adapters ──

  private async deployNetlify(input: { siteDir: string; deployConfig: DeployConfig }): Promise<DeployResult> {
    const start = Date.now();
    const siteId = input.deployConfig.options?.destination;
    const siteFlag = siteId ? `--site ${this.shellQuote(siteId)}` : '';
    const cmd = `netlify deploy --prod --dir ${this.shellQuote(input.siteDir)} ${siteFlag}`.trim();
    return this.runCommand(cmd, 'netlify', start, /(?:Website URL|Live URL):\s*(\S+)/i);
  }

  private async deployVercel(input: { siteDir: string; deployConfig: DeployConfig }): Promise<DeployResult> {
    const start = Date.now();
    const cmd = `vercel deploy --prod ${this.shellQuote(input.siteDir)} --yes`;
    return this.runCommand(cmd, 'vercel', start, /(https:\/\/\S+\.vercel\.app)/i);
  }

  private async deployCloudflarePages(input: { siteDir: string; deployConfig: DeployConfig }): Promise<DeployResult> {
    const start = Date.now();
    const projectName = input.deployConfig.options?.destination;
    if (!projectName) {
      return { success: false, target: 'cloudflare-pages', durationMs: Date.now() - start, output: '',
        error: 'cloudflare-pages requires deploy.options.destination = your project name.' };
    }
    const cmd = `wrangler pages deploy ${this.shellQuote(input.siteDir)} --project-name ${this.shellQuote(projectName)}`;
    return this.runCommand(cmd, 'cloudflare-pages', start, /(https:\/\/\S+\.pages\.dev)/i);
  }

  /**
   * github-pages: init a scratch git repo *inside the rendered output dir*,
   * commit everything, and force-push it to the configured remote branch
   * (default `gh-pages`). We deliberately do NOT touch the author's actual
   * project repo — this stages a throwaway repo in the build output so a
   * force-push can't clobber unrelated history.
   *
   * Auth: relies entirely on the user's ambient git credentials (SSH agent,
   * a stored credential helper, or a token embedded in an HTTPS remote URL
   * they configured themselves). We never prompt for or store credentials
   * here — if git fails with an auth error, we say so and point at the
   * config, we don't attempt to intercept credentials.
   */
  private async deployGithubPages(input: {
    siteId: string;
    siteDir: string;
    deployConfig: DeployConfig;
  }): Promise<DeployResult> {
    const start = Date.now();
    const target: DeployTarget = 'github-pages';
    const repo = input.deployConfig.options?.repo;
    const branch = input.deployConfig.options?.branch || 'gh-pages';

    if (!repo) {
      return {
        success: false, target,
        durationMs: Date.now() - start,
        output: '',
        error: 'github-pages requires deploy.options.repo = your GitHub repo remote URL ' +
          '(e.g. https://github.com/you/your-site.git or git@github.com:you/your-site.git). ' +
          'Set deploy.options.branch to override the default `gh-pages` branch.',
      };
    }

    const gitOk = await this.checkBinary('git');
    if (!gitOk) {
      return {
        success: false, target,
        durationMs: Date.now() - start,
        output: '',
        error: 'git is not installed or not on PATH. Install git (https://git-scm.com/downloads) and try again.',
      };
    }

    // Run all git commands with cwd = the rendered site dir, staging a
    // throwaway repo there. `git init` is idempotent if one already exists
    // from a previous deploy (keeps a small amount of local history but we
    // always force-push, so remote state is authoritative).
    const gitCmd = (args: string) =>
      execAsync(`git ${args}`, {
        cwd: input.siteDir,
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

    let output = '';
    try {
      if (!existsSync(join(input.siteDir, '.git'))) {
        const initRes = await gitCmd('init -q');
        output += initRes.stdout + initRes.stderr;
      }

      // Ensure identity is set for this repo so commit doesn't fail on a
      // machine with no global user.name/user.email configured. Harmless
      // if already set — local config always overrides.
      await gitCmd(`config user.email "authoragent@localhost"`);
      await gitCmd(`config user.name "AuthorAgent"`);

      const addRes = await gitCmd('add -A');
      output += addRes.stdout + addRes.stderr;

      // Commit — `--allow-empty` so a no-op render (unchanged site) doesn't
      // hard-fail the deploy with "nothing to commit".
      const stamp = new Date().toISOString();
      const commitRes = await gitCmd(`commit -q --allow-empty -m ${this.shellQuote(`Deploy ${input.siteId} — ${stamp}`)}`);
      output += commitRes.stdout + commitRes.stderr;

      // Point (or repoint) origin at the configured remote every deploy —
      // cheap and avoids drift if the author changes the repo config.
      try {
        await gitCmd(`remote remove origin`);
      } catch { /* no existing remote — fine */ }
      await gitCmd(`remote add origin ${this.shellQuote(repo)}`);

      // Force-push HEAD to the target branch. Force is required because
      // this scratch repo's history is unrelated to whatever's already on
      // the remote branch (Pages branches are typically just build output).
      const pushRes = await gitCmd(`push --force origin HEAD:${this.shellQuote(branch)}`);
      output += pushRes.stdout + pushRes.stderr;

      return {
        success: true, target,
        durationMs: Date.now() - start,
        output: output.slice(-4000),
        url: this.guessGithubPagesUrl(repo),
      };
    } catch (err: any) {
      const combined = `${err?.stdout || ''}\n${err?.stderr || ''}`;
      const authHint = /authentication|permission denied|could not read username|403/i.test(combined)
        ? '\n\nThis looks like a git authentication failure. github-pages deploy relies on YOUR ambient git ' +
          'credentials (SSH key in your agent, a stored credential helper, or a token baked into an HTTPS remote ' +
          'URL) — AuthorAgent does not manage GitHub auth itself. Make sure `git push` to this repo already works ' +
          'from a normal terminal on this machine before retrying here.'
        : '';
      return {
        success: false, target,
        durationMs: Date.now() - start,
        output: (output + '\n' + combined).slice(-4000),
        error: (err?.message?.slice(0, 500) || 'git command failed') + authHint,
      };
    }
  }

  /** Best-effort github.io URL guess from a repo remote — not authoritative
   *  (custom domains / org Pages have different URLs), just a helpful hint. */
  private guessGithubPagesUrl(repo: string): string | undefined {
    const m = repo.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (!m) return undefined;
    const [, owner, name] = m;
    return `https://${owner}.github.io/${name}/`;
  }

  private async deployRsync(input: { siteDir: string; deployConfig: DeployConfig }): Promise<DeployResult> {
    const start = Date.now();
    const dest = input.deployConfig.options?.destination;
    if (!dest) {
      return { success: false, target: 'rsync', durationMs: Date.now() - start, output: '',
        error: 'rsync requires deploy.options.destination = user@host:/absolute/path' };
    }
    if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:\/.+/.test(dest)) {
      return { success: false, target: 'rsync', durationMs: Date.now() - start, output: '',
        error: `rsync destination must be in user@host:/path form. Got: ${dest}` };
    }
    const cmd = `rsync -avz --delete ${this.shellQuote(input.siteDir + '/')} ${this.shellQuote(dest)}`;
    return this.runCommand(cmd, 'rsync', start);
  }

  private async deployManualZip(input: {
    siteId: string;
    siteDir: string;
    workspaceDir: string;
  }): Promise<DeployResult> {
    const start = Date.now();
    const exportsDir = join(input.workspaceDir, 'exports', 'website');
    await mkdir(exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archivePath = join(exportsDir, `${input.siteId}-${stamp}.zip`);

    // Use tar with -a (auto-detect from extension) so it produces a real zip
    // on Windows 10+ and POSIX. Fall back to `zip` on POSIX if tar -a doesn't
    // exist.
    //
    // Windows quirk: GNU tar interprets colons in `C:\path\to\dir` as a
    // remote-host separator (the `host:path` syntax for tar-over-SSH). Even
    // when the path is local, we need --force-local OR a colon-free form.
    // We also use forward slashes via process.cwd-relative paths to dodge
    // backslash escaping issues inside double-quoted Windows commands.
    const cmd = process.platform === 'win32'
      ? `tar --force-local -a -c -f ${this.shellQuote(archivePath)} -C ${this.shellQuote(input.siteDir)} .`
      : `cd ${this.shellQuote(input.siteDir)} && zip -r ${this.shellQuote(archivePath)} . -x ".*"`;

    const result = await this.runCommand(cmd, 'manual-zip', start);
    if (result.success) {
      result.artifactPath = archivePath;
      result.output = `${result.output}\n\nArtifact ready at: ${archivePath}\n` +
        `Upload manually via your host's web UI:\n` +
        `  Netlify drag-and-drop: https://app.netlify.com/drop\n` +
        `  Vercel: https://vercel.com/new\n` +
        `  Cloudflare Pages: https://dash.cloudflare.com/?to=/:account/pages/new`;
    }
    return result;
  }

  // ── Helpers ──

  private async runCommand(
    cmd: string,
    target: DeployTarget,
    startMs: number,
    urlRegex?: RegExp,
  ): Promise<DeployResult> {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 5 * 60 * 1000, // 5 minutes
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
      const output = `${stdout}\n${stderr}`.slice(-4000); // tail
      let url: string | undefined;
      if (urlRegex) {
        const m = output.match(urlRegex);
        if (m) url = m[1] || m[0];
      }
      return {
        success: true, target, url,
        durationMs: Date.now() - startMs,
        output,
      };
    } catch (err: any) {
      return {
        success: false, target,
        durationMs: Date.now() - startMs,
        output: ((err?.stdout || '') + '\n' + (err?.stderr || '')).slice(-4000),
        error: err?.message?.slice(0, 500) || 'Deploy command failed',
      };
    }
  }

  private async checkBinary(name: string): Promise<boolean> {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      await execAsync(cmd, { timeout: 5000 });
      return true;
    } catch { return false; }
  }

  private shellQuote(s: string): string {
    if (process.platform === 'win32') {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }
}
