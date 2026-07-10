/**
 * AuthorAgent Model Config Store
 *
 * Persists a user-editable map of provider id -> model string so the owner can
 * switch a provider's model (e.g. try Claude Fable 5, or a future GPT/Gemini
 * model) from a setting instead of editing a config file or restarting.
 *
 * Lives at workspace/data/model-config.json. Mirrors the atomic tmp+rename
 * persistence pattern used by ImageGenService (services/image-gen.ts).
 *
 * An absent or empty entry means "use the provider's current default" — the
 * router applies precedence: model-config.json override → config.<provider>.model
 * → hardcoded default. So an empty store leaves behavior identical to today.
 */

import { mkdir, writeFile, readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

/** provider id -> chosen model string. */
export type ModelOverrides = Record<string, string>;

export class ModelConfig {
  private dataDir: string;
  private configPath: string;
  private overrides: ModelOverrides = {};

  constructor(workspaceDir: string) {
    this.dataDir = join(workspaceDir, 'data');
    this.configPath = join(this.dataDir, 'model-config.json');
  }

  /** Load persisted overrides from disk. Missing file = empty overrides (no
   *  file is written until a model is actually set, so we don't create noise). */
  async load(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        this.overrides = {};
        return;
      }
      const raw = await readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.overrides = this.sanitize(parsed);
    } catch {
      // Corrupted config — fall back to empty in memory, don't clobber the file.
      this.overrides = {};
    }
  }

  /** Keep only string -> non-empty-string entries. */
  private sanitize(parsed: any): ModelOverrides {
    const out: ModelOverrides = {};
    if (parsed && typeof parsed === 'object') {
      for (const [provider, model] of Object.entries(parsed)) {
        if (typeof provider === 'string' && typeof model === 'string' && model.trim().length > 0) {
          out[provider] = model.trim();
        }
      }
    }
    return out;
  }

  /** Persist overrides to disk (atomic write via temp file + rename). */
  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = this.configPath + '.tmp';
    await writeFile(tmp, JSON.stringify(this.overrides, null, 2));
    await rename(tmp, this.configPath);
  }

  /** Get the override model for a provider, or undefined if none set. */
  get(provider: string): string | undefined {
    return this.overrides[provider];
  }

  /** Return a copy of all overrides. */
  getAll(): ModelOverrides {
    return { ...this.overrides };
  }

  /**
   * Set (or clear) a provider's model override and persist.
   * Passing an empty/whitespace model clears the override (revert to default).
   */
  async set(provider: string, model: string): Promise<void> {
    const trimmed = (model || '').trim();
    if (trimmed.length === 0) {
      delete this.overrides[provider];
    } else {
      this.overrides[provider] = trimmed;
    }
    await this.save();
  }
}
