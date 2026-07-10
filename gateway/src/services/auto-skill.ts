/**
 * AuthorAgent Auto-Skill Creator — Hermes-inspired automatic skill capture.
 *
 * When a project completes successfully (or a multi-step workflow finishes
 * cleanly), this service distills the steps + outcomes into a SKILL.md
 * draft so the next similar task can match the same workflow.
 *
 * Two modes:
 *   - User-triggered (via existing skill-acquisition skill / API)
 *   - Automatic (this service) — runs on project completion if the project
 *     has 4+ completed steps and no existing skill matches its shape.
 *
 * Both modes go through DRAFT → REVIEW. Drafts are stored in
 * skills/_drafts/<slug>/SKILL.md and NEVER auto-promoted to skills/ops/
 * without user approval. The user reviews the draft in the dashboard and
 * either accepts (moves to skills/ops/) or rejects (deletes draft).
 *
 * Why drafts? OpenAI's "automatic skill creation" patterns burn through
 * the skill catalog with low-quality entries. Hermes's curated approach
 * (user accepts before save) keeps the catalog signal:noise high.
 */

import { readFile, writeFile, readdir, mkdir, rename, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string }>;

export type AIProviderSelectFn = (taskType: string) => { id: string };

export interface SkillDraft {
  id: string;
  slug: string;
  draftPath: string;
  generatedAt: string;
  source: 'auto-from-project' | 'user-request';
  sourceProjectId?: string;
  sourceProjectTitle?: string;
  /** SKILL.md content as a string. */
  content: string;
  /** Inferred skill name from the YAML frontmatter. */
  skillName: string;
  /** User's decision so far. */
  status: 'pending_review' | 'accepted' | 'rejected';
}

interface PersistedState {
  drafts: SkillDraft[];
}

// ═══════════════════════════════════════════════════════════
// Prompt template
// ═══════════════════════════════════════════════════════════

const SKILL_DRAFT_PROMPT = `You are drafting a SKILL.md file for AuthorAgent — a YAML-frontmatter + Markdown document that captures a reusable workflow.

You will be given a project's title, description, and an ordered list of its steps with their results. Distill that into a SKILL.md the next user can reuse for similar work.

Output format MUST be exactly:

---
name: <kebab-case skill name, lowercase, no spaces>
description: <one sentence ≤120 chars describing what this skill does>
triggers:
  - <trigger phrase 1>
  - <trigger phrase 2>
  - <trigger phrase 3>
  - <at least 3, max 8>
permissions:
  - memory_read
---

# <Title Case skill name>

<2-3 paragraph description of what the skill does and when to use it>

## Workflow

1. <Step 1 — one sentence imperative>
2. <Step 2 ...>
3. ...

## When to use this skill

- <bullet 1>
- <bullet 2>
- <bullet 3>

Rules:
- DO NOT include any specific manuscript content, character names, or plot details
- DO NOT include the user's project title verbatim
- KEEP it generic — this is a reusable PATTERN, not a copy of one project
- Triggers must be UNIQUE phrases an author would actually type
- name MUST be kebab-case, no underscores, no spaces
- Output ONLY the SKILL.md — no commentary, no markdown fences, no preamble`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const MIN_STEPS_FOR_AUTO = 4;

export class AutoSkillService {
  private state: PersistedState = { drafts: [] };
  private rootDir: string;
  private statePath: string;
  private draftsDir: string;
  private aiComplete: AICompleteFn | null = null;
  private aiSelectProvider: AIProviderSelectFn | null = null;
  private existingSkillNames: () => Set<string> = () => new Set();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.statePath = join(rootDir, 'workspace', 'auto-skill-drafts.json');
    this.draftsDir = join(rootDir, 'skills', '_drafts');
  }

  setAI(complete: AICompleteFn, selectProvider: AIProviderSelectFn): void {
    this.aiComplete = complete;
    this.aiSelectProvider = selectProvider;
  }

  /** Wire a callback that returns the names of skills already in the catalog
   *  (so we don't generate duplicates). */
  setExistingSkillsLookup(fn: () => Set<string>): void {
    this.existingSkillNames = fn;
  }

  async initialize(): Promise<void> {
    await mkdir(this.draftsDir, { recursive: true });
    if (!existsSync(this.statePath)) return;
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.state.drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
    } catch { /* corrupted — start fresh */ }
  }

  /**
   * Auto-trigger: called by the gateway when a project completes. Decides
   * whether to draft a skill, then runs the drafter. Fire-and-forget.
   */
  async maybeDraftFromProject(project: {
    id: string;
    type: string;
    title: string;
    description: string;
    steps: Array<{ label: string; status: string; result?: string }>;
  }): Promise<SkillDraft | null> {
    if (!this.aiComplete || !this.aiSelectProvider) return null;
    const completedSteps = project.steps.filter(s => s.status === 'completed');
    if (completedSteps.length < MIN_STEPS_FOR_AUTO) return null;

    // Skip projects whose type already has a strong skill (book-production
    // is well-covered by the write skill, etc.).
    const skipTypes = new Set(['book-production', 'novel-pipeline']);
    if (skipTypes.has(project.type)) return null;

    return this.draftFromProject(project, 'auto-from-project');
  }

  /**
   * User-triggered version (via /api or skill-acquisition skill).
   * Same drafter, different `source` label.
   */
  async draftFromProject(
    project: {
      id: string;
      type: string;
      title: string;
      description: string;
      steps: Array<{ label: string; status: string; result?: string }>;
    },
    source: SkillDraft['source'] = 'user-request',
  ): Promise<SkillDraft | null> {
    if (!this.aiComplete || !this.aiSelectProvider) return null;

    const userMessage = [
      `Project type: ${project.type}`,
      `Project title: ${project.title}`,
      `Project description: ${project.description}`,
      ``,
      `Steps:`,
      ...project.steps
        .filter(s => s.status === 'completed')
        .map((s, i) => `${i + 1}. ${s.label}\n   ${(s.result || '').substring(0, 600).replace(/\n/g, ' ')}`),
    ].join('\n');

    let content = '';
    try {
      const provider = this.aiSelectProvider('general');
      const response = await this.aiComplete({
        provider: provider.id,
        system: SKILL_DRAFT_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 1200,
        temperature: 0.4,
      });
      content = (response.text || '').trim();
    } catch (err) {
      console.warn('  [auto-skill] draft generation failed:', (err as Error)?.message || err);
      return null;
    }

    if (!content || !content.startsWith('---')) {
      console.warn('  [auto-skill] AI returned malformed SKILL.md — skipping draft.');
      return null;
    }

    // Pull the skill name out of the frontmatter for slug + dedup checks.
    const nameMatch = content.match(/^name:\s*([a-z0-9-]+)\s*$/m);
    const skillName = nameMatch ? nameMatch[1] : `auto-${Date.now().toString(36)}`;
    const existing = this.existingSkillNames();
    if (existing.has(skillName)) {
      console.log(`  [auto-skill] Skill "${skillName}" already exists — discarding draft.`);
      return null;
    }

    const slug = skillName.replace(/[^a-z0-9-]/g, '-').slice(0, 60) || `draft-${Date.now()}`;
    const draftDir = join(this.draftsDir, slug);
    await mkdir(draftDir, { recursive: true });
    const draftPath = join(draftDir, 'SKILL.md');
    await writeFile(draftPath, content, 'utf-8');

    const draft: SkillDraft = {
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      slug,
      draftPath,
      generatedAt: new Date().toISOString(),
      source,
      sourceProjectId: project.id,
      sourceProjectTitle: project.title,
      content,
      skillName,
      status: 'pending_review',
    };
    this.state.drafts.push(draft);
    await this.persist();
    console.log(`  ✓ Auto-drafted skill "${skillName}" (review in dashboard)`);
    return draft;
  }

  list(filter?: { status?: SkillDraft['status'] }): SkillDraft[] {
    let result = [...this.state.drafts];
    if (filter?.status) result = result.filter(d => d.status === filter.status);
    return result.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  get(id: string): SkillDraft | undefined {
    return this.state.drafts.find(d => d.id === id);
  }

  /** Accept a draft → moves SKILL.md from _drafts/ to ops/ and reloads skills. */
  async accept(id: string, opts: { category?: 'ops' | 'author' | 'core' | 'marketing' } = {}): Promise<{
    success: boolean;
    message: string;
    finalPath?: string;
  }> {
    const draft = this.state.drafts.find(d => d.id === id);
    if (!draft) return { success: false, message: 'Draft not found' };
    if (draft.status !== 'pending_review') return { success: false, message: `Already ${draft.status}` };
    if (!existsSync(draft.draftPath)) return { success: false, message: 'Draft file missing on disk' };

    const category = opts.category || 'ops';
    const targetDir = join(this.rootDir, 'skills', category, draft.slug);
    if (existsSync(targetDir)) {
      return { success: false, message: `A skill folder already exists at skills/${category}/${draft.slug}` };
    }
    await mkdir(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'SKILL.md');
    try {
      await rename(draft.draftPath, targetPath);
      // Clean up the empty draft directory
      await rm(join(this.draftsDir, draft.slug), { recursive: true, force: true });
    } catch (err: any) {
      return { success: false, message: `Move failed: ${err?.message || err}` };
    }
    draft.status = 'accepted';
    draft.draftPath = targetPath; // record final location
    await this.persist();
    return {
      success: true,
      message: `Skill installed at skills/${category}/${draft.slug}/SKILL.md. Restart AuthorAgent to load it.`,
      finalPath: targetPath,
    };
  }

  /** Reject a draft → deletes the SKILL.md file + marks rejected. */
  async reject(id: string): Promise<{ success: boolean; message: string }> {
    const draft = this.state.drafts.find(d => d.id === id);
    if (!draft) return { success: false, message: 'Draft not found' };
    if (draft.status !== 'pending_review') return { success: false, message: `Already ${draft.status}` };
    try {
      const draftDir = join(this.draftsDir, draft.slug);
      if (existsSync(draftDir)) await rm(draftDir, { recursive: true, force: true });
    } catch { /* file may already be gone */ }
    draft.status = 'rejected';
    await this.persist();
    return { success: true, message: 'Draft rejected and deleted.' };
  }

  /** List the on-disk drafts (in case state and disk diverge). */
  async listDraftFolders(): Promise<string[]> {
    if (!existsSync(this.draftsDir)) return [];
    try {
      return (await readdir(this.draftsDir)).filter(f => !f.startsWith('.'));
    } catch { return []; }
  }

  // ── Persistence ──

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.statePath, '..'), { recursive: true });
      const tmp = this.statePath + '.tmp';
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.statePath);
    } catch (err) {
      console.error('  ✗ Failed to persist auto-skill state:', err);
    }
  }
}
