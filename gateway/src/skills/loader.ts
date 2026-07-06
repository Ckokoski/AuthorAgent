/**
 * AuthorClaw Skill Loader
 * Discovers, validates, and loads skills from the skills directory
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { PermissionManager } from '../security/permissions.js';

export interface Skill {
  name: string;
  description: string;
  category: 'core' | 'author' | 'marketing' | 'premium' | 'ops';
  triggers: string[];
  permissions: string[];
  content: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  triggers: string[];
  premium: boolean;
}

export class SkillLoader {
  private skillsDir: string;
  private permissions: PermissionManager;
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string, permissions: PermissionManager) {
    this.skillsDir = skillsDir;
    this.permissions = permissions;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();
    // Note: 'ops' was previously missing from this list, so Wave 2's ops
    // skills (decision-maker, task-planner, orchestrator-mgmt) and Wave 3's
    // browser-automation never actually loaded. Now included.
    for (const category of ['core', 'author', 'marketing', 'premium', 'ops'] as const) {
      const categoryDir = join(this.skillsDir, category);
      if (!existsSync(categoryDir)) continue;

      const entries = await readdir(categoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('{')) continue;

          const skillPath = join(categoryDir, entry.name, 'SKILL.md');
          if (existsSync(skillPath)) {
            try {
              const content = await readFile(skillPath, 'utf-8');
              const skill = this.parseSkill(content, entry.name, category);
              if (skill) {
                this.skills.set(skill.name, skill);
                if (category === 'premium') {
                  console.log(`  ★ Premium skill loaded: ${skill.name}`);
                }
              }
            } catch (error) {
              console.error(`  ⚠ Failed to load skill: ${entry.name}`, error);
            }
          }
        }
      }
    }
  }

  /**
   * Register synthetic skills generated at runtime — e.g., from Author OS tools.
   * No SKILL.md file is required; the data is provided directly.
   * Synthetic skills get category 'author' and are merged into the catalog.
   */
  registerSynthetic(skills: Array<{
    name: string;
    description: string;
    triggers: string[];
    permissions?: string[];
  }>): number {
    let added = 0;
    for (const s of skills) {
      if (!s.name || !s.description || !Array.isArray(s.triggers) || s.triggers.length === 0) continue;
      // Don't override an explicitly-authored SKILL.md of the same name.
      if (this.skills.has(s.name)) continue;
      this.skills.set(s.name, {
        name: s.name,
        description: s.description,
        category: 'author',
        triggers: s.triggers,
        permissions: s.permissions || ['memory_read'],
        content: `# ${s.name}\n\n${s.description}\n\n_(Auto-generated from Author OS tools.)_`,
      });
      added++;
    }
    return added;
  }

  /** Skills already warned about — dedupe so each skill warns once per process. */
  private warnedSkills: Set<string> = new Set();

  /**
   * Lightweight frontmatter validation. Warns (once per skill) about
   * missing/malformed fields; never throws — the skill still loads with
   * whatever could be parsed.
   */
  private validateFrontmatter(
    skillName: string,
    frontmatter: string,
    parsed: { description: string; triggers: string[]; permissions: string[] },
  ): void {
    if (this.warnedSkills.has(skillName)) return;
    const problems: string[] = [];
    for (const field of ['name', 'description', 'author', 'version', 'triggers', 'permissions']) {
      if (!new RegExp(`^${field}:`, 'm').test(frontmatter)) problems.push(`missing "${field}"`);
    }
    if (!parsed.description) problems.push('empty description');
    if (parsed.triggers.length === 0) problems.push('no triggers parsed');
    if (problems.length > 0) {
      this.warnedSkills.add(skillName);
      console.warn(`  ⚠ Skill "${skillName}" frontmatter issues: ${problems.join(', ')}`);
    }
  }

  private parseSkill(content: string, name: string, category: 'core' | 'author' | 'marketing' | 'premium' | 'ops'): Skill | null {
    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      if (!this.warnedSkills.has(name)) {
        this.warnedSkills.add(name);
        console.warn(`  ⚠ Skill "${name}" has no YAML frontmatter — skipped`);
      }
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const triggers: string[] = [];
    const permissions: string[] = [];
    let description = '';
    let currentSection = '';

    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();

      // Track which YAML key we're under
      if (trimmed.match(/^\w/)) {
        if (trimmed.startsWith('description:')) {
          description = trimmed.replace('description:', '').trim();
          currentSection = 'description';
        } else if (trimmed.startsWith('triggers:')) {
          currentSection = 'triggers';
        } else if (trimmed.startsWith('permissions:')) {
          currentSection = 'permissions';
        } else {
          currentSection = '';
        }
        continue;
      }

      // Parse list items under the current section
      if (trimmed.startsWith('- ')) {
        const value = trimmed.replace(/^- ["']?|["']$/g, '').trim();
        if (currentSection === 'triggers') {
          triggers.push(value);
        } else if (currentSection === 'permissions') {
          permissions.push(value);
        }
      }
    }

    this.validateFrontmatter(name, frontmatter, { description, triggers, permissions });
    return { name, description, category, triggers, permissions, content };
  }

  /**
   * Match skills against user input, ranked by match quality, capped at the
   * top MAX_MATCHED_SKILLS, with a total injected-content budget so skill
   * bodies can't bloat the system prompt unbounded.
   *
   * Returns an array of prompt-ready strings (backward-compatible shape:
   * callers join these into the system prompt).
   */
  matchSkills(input: string): string[] {
    const MAX_MATCHED_SKILLS = 3;
    const CONTENT_BUDGET_CHARS = 8000;

    const lower = input.toLowerCase();
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ── Score every skill ──
    const scored: Array<{ skill: Skill; score: number }> = [];
    for (const [, skill] of this.skills) {
      let score = 0;
      let hits = 0;
      for (const trigger of skill.triggers) {
        const t = trigger.toLowerCase().trim();
        if (!t || !lower.includes(t)) continue;
        hits++;
        // Exact word/phrase match (bounded by non-word chars) beats substring.
        const wordBounded = new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(lower);
        // Longer trigger matches are more specific → score higher.
        score += (wordBounded ? 10 : 4) + Math.min(t.length, 30) / 3;
      }
      if (hits > 0) {
        // Multiple trigger hits → stronger signal.
        score += (hits - 1) * 5;
        scored.push({ skill, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_MATCHED_SKILLS);

    // ── Assemble within budget ──
    const results: string[] = [];
    let used = 0;
    for (const { skill } of top) {
      // Description header is always included, regardless of budget.
      const header = `## Skill: ${skill.name}\n${skill.description}\n`;
      used += header.length;

      const remaining = CONTENT_BUDGET_CHARS - used;
      if (skill.content.length <= remaining) {
        results.push(header + '\n' + skill.content);
        used += skill.content.length;
      } else if (remaining > 200) {
        const cut = skill.content.length - remaining;
        results.push(header + '\n' + skill.content.slice(0, remaining) + '\n[truncated]');
        used = CONTENT_BUDGET_CHARS;
        console.log(`  ⚠ Skill "${skill.name}" body truncated by ${cut} chars to fit ${CONTENT_BUDGET_CHARS}-char prompt budget`);
      } else {
        // Budget exhausted — description only.
        results.push(header);
        console.log(`  ⚠ Skill "${skill.name}" body omitted (${skill.content.length} chars) — prompt budget exhausted`);
      }
    }

    return results;
  }

  getLoadedCount(): number {
    return this.skills.size;
  }

  getAuthorSkillCount(): number {
    return Array.from(this.skills.values()).filter(s => s.category === 'author').length;
  }

  getPremiumSkillCount(): number {
    return Array.from(this.skills.values()).filter(s => s.category === 'premium').length;
  }

  getPremiumSkills(): Array<{ name: string; description: string }> {
    return Array.from(this.skills.values())
      .filter(s => s.category === 'premium')
      .map(s => ({ name: s.name, description: s.description }));
  }

  /**
   * Return a lightweight catalog of all loaded skills (for AI task planning).
   * Includes name, description, triggers, category — but NOT the full content.
   */
  getSkillCatalog(): SkillCatalogEntry[] {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      category: s.category,
      triggers: s.triggers,
      premium: s.category === 'premium',
    }));
  }

  /**
   * Get a specific skill by name (returns full content for injection into prompt).
   */
  getSkillByName(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get skills grouped by category for dashboard display.
   */
  getSkillsByCategory(): Record<string, Array<{ name: string; description: string }>> {
    const grouped: Record<string, Array<{ name: string; description: string }>> = {};
    for (const skill of this.skills.values()) {
      if (!grouped[skill.category]) grouped[skill.category] = [];
      grouped[skill.category].push({ name: skill.name, description: skill.description });
    }
    return grouped;
  }
}
