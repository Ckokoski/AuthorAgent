import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillLoader } from '../skills/loader.js';
import { PermissionManager } from '../security/permissions.js';
import {
  SkillCuratorService,
  type CuratorAICompleteFn,
  type CuratorAISelectProviderFn,
} from './skill-curator.js';

/** Write a fixture SKILL.md at skills/<category>/<name>/SKILL.md. */
async function writeSkillFixture(
  skillsDir: string,
  category: string,
  name: string,
  opts: { description: string; triggers: string[]; body?: string },
): Promise<void> {
  const dir = join(skillsDir, category, name);
  await mkdir(dir, { recursive: true });
  const triggerLines = opts.triggers.map(t => `  - "${t}"`).join('\n');
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${opts.description}`,
    'author: test',
    'version: 1.0.0',
    'triggers:',
    triggerLines,
    'permissions:',
    '  - "memory_read"',
    '---',
  ].join('\n');
  const content = `${frontmatter}\n\n${opts.body || `# ${name}\n\nBody for ${name}.`}\n`;
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8');
}

describe('SkillCuratorService.curate', () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'authoragent-curator-test-'));
    // No workspaceDir → usage stays in-memory (no disk writes) for the tests.
    loader = new SkillLoader(skillsDir, new PermissionManager('standard'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('never throws on an empty skill library and reports zero skills', async () => {
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    expect(report.totalSkills).toBe(0);
    expect(report.unused).toEqual([]);
    expect(report.overlapping).toEqual([]);
    expect(report.redundantWithService).toEqual([]);
    expect(typeof report.summary).toBe('string');
    expect(report.aiSummary).toBe(false);
  });

  it('flags all skills as unused (never-used) when nothing has matched', async () => {
    await writeSkillFixture(skillsDir, 'core', 'alpha', { description: 'Alpha skill', triggers: ['aaa'] });
    await writeSkillFixture(skillsDir, 'core', 'beta', { description: 'Beta skill', triggers: ['bbb'] });
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    const unusedNames = report.unused.map(u => u.name).sort();
    expect(unusedNames).toEqual(['alpha', 'beta']);
    expect(report.unused.every(u => u.reason === 'never-used')).toBe(true);
  });

  it('does NOT flag a skill as unused after it has been matched', async () => {
    await writeSkillFixture(skillsDir, 'core', 'outline-skill', { description: 'Build an outline', triggers: ['outline'] });
    await writeSkillFixture(skillsDir, 'core', 'never', { description: 'Never used', triggers: ['zzz'] });
    await loader.loadAll();
    // Simulate a chat message matching the outline skill.
    loader.matchSkills('please write an outline for my book');

    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    const unusedNames = report.unused.map(u => u.name);
    expect(unusedNames).toContain('never');
    expect(unusedNames).not.toContain('outline-skill');
  });

  it('flags a used-but-stale skill (last used before the threshold)', async () => {
    await writeSkillFixture(skillsDir, 'core', 'staleish', { description: 'Stale-ish', triggers: ['staletrigger'] });
    await loader.loadAll();
    loader.matchSkills('staletrigger here'); // records usage "now"

    const curator = new SkillCuratorService(loader);
    // Negative threshold → staleMs < 0, so even a same-millisecond match
    // (now - last === 0) exceeds it and counts as stale. Avoids relying on
    // sub-millisecond wall-clock timing in the test.
    const report = await curator.curate({ staleAfterDays: -1 });
    const stale = report.unused.find(u => u.name === 'staleish');
    expect(stale).toBeDefined();
    expect(stale!.reason).toBe('stale');
    expect(stale!.lastUsedIso).toBeTruthy();
  });

  it('detects an overlapping pair of highly-similar skills and proposes a merge', async () => {
    // Two near-identical skills — same triggers, near-identical descriptions.
    await writeSkillFixture(skillsDir, 'marketing', 'blurb-writer', {
      description: 'Write a punchy back-cover book blurb for marketing',
      triggers: ['write a blurb', 'book blurb', 'back cover copy'],
    });
    await writeSkillFixture(skillsDir, 'marketing', 'blurb-maker', {
      description: 'Write a punchy back-cover book blurb for marketing',
      triggers: ['write a blurb', 'book blurb', 'back cover copy'],
    });
    // A clearly different skill that should NOT pair with the blurb skills.
    await writeSkillFixture(skillsDir, 'core', 'continuity-checker', {
      description: 'Check chapters for timeline and character continuity errors',
      triggers: ['continuity check', 'timeline consistency'],
    });
    await loader.loadAll();

    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    // The two blurb skills must be flagged as overlapping.
    const pair = report.overlapping.find(
      p => [p.a, p.b].sort().join('|') === ['blurb-maker', 'blurb-writer'].join('|'),
    );
    expect(pair).toBeDefined();
    expect(pair!.similarity).toBeGreaterThanOrEqual(0.6);
    expect(pair!.recommendation).toMatch(/merg/i);

    // The dissimilar continuity skill must NOT overlap with the blurb skills.
    const badPair = report.overlapping.find(
      p => p.a === 'continuity-checker' || p.b === 'continuity-checker',
    );
    expect(badPair).toBeUndefined();
  });

  it('does NOT flag two dissimilar skills as overlapping', async () => {
    await writeSkillFixture(skillsDir, 'core', 'kdp-export', {
      description: 'Export a manuscript to KDP-ready formats',
      triggers: ['export to kdp', 'kindle format'],
    });
    await writeSkillFixture(skillsDir, 'marketing', 'ad-copy', {
      description: 'Draft Amazon advertising copy and keywords',
      triggers: ['write ad copy', 'ams keywords'],
    });
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    expect(report.overlapping).toHaveLength(0);
  });

  it('flags the style-clone skill as redundant with StyleCloneService', async () => {
    await writeSkillFixture(skillsDir, 'author', 'style-clone', {
      description: "Analyze and match the author's unique writing voice",
      triggers: ['learn my style', 'voice profile'],
    });
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    expect(report.redundantWithService).toHaveLength(1);
    const flag = report.redundantWithService[0];
    expect(flag.skill).toBe('style-clone');
    expect(flag.service).toBe('StyleCloneService');
    expect(flag.route).toMatch(/\/api\/style-clone\/analyze/);
    expect(flag.recommendation).toMatch(/service/i);
  });

  it('does not flag service redundancy when style-clone is absent', async () => {
    await writeSkillFixture(skillsDir, 'core', 'unrelated', { description: 'd', triggers: ['t'] });
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    const report = await curator.curate();
    expect(report.redundantWithService).toHaveLength(0);
  });

  it('requests only the FREE tier when an AI summary is produced (spy)', async () => {
    await writeSkillFixture(skillsDir, 'author', 'style-clone', {
      description: "Analyze the author's voice",
      triggers: ['learn my style'],
    });
    await loader.loadAll();

    const taskTypesSeen: string[] = [];
    const aiSelectProvider: CuratorAISelectProviderFn = (taskType) => {
      taskTypesSeen.push(taskType);
      return { id: 'gemini', tier: 'free' };
    };
    const aiComplete = vi.fn(async (req: any) => ({
      text: 'Point style-clone at the service first; it is the highest-impact, lowest-risk fix.',
      tokensUsed: 10,
      estimatedCost: 0,
      provider: req.provider,
    }));

    const curator = new SkillCuratorService(loader, aiComplete as any, aiSelectProvider);
    const report = await curator.curate();

    expect(aiComplete).toHaveBeenCalledTimes(1);
    expect(report.aiSummary).toBe(true);
    expect(report.summary).toMatch(/style-clone|service/i);
    // Cost rule: every task type requested must be free-tier.
    expect(taskTypesSeen.length).toBeGreaterThan(0);
    for (const t of taskTypesSeen) expect(['general', 'research', 'marketing']).toContain(t);
  });

  it('never spends an AI call when the resolved provider is NOT free-tier', async () => {
    await writeSkillFixture(skillsDir, 'author', 'style-clone', {
      description: "Analyze the author's voice",
      triggers: ['learn my style'],
    });
    await loader.loadAll();

    const aiComplete = vi.fn(async (req: any) => ({ text: 'x', tokensUsed: 0, estimatedCost: 0, provider: req.provider }));
    const aiSelectProvider: CuratorAISelectProviderFn = () => ({ id: 'claude', tier: 'paid' });

    const curator = new SkillCuratorService(loader, aiComplete as any, aiSelectProvider);
    const report = await curator.curate();

    // Cost-rule breach → no completion spent, deterministic summary kept.
    expect(aiComplete).not.toHaveBeenCalled();
    expect(report.aiSummary).toBe(false);
    expect(report.summary).toBeTruthy();
    // But the findings themselves are still produced.
    expect(report.redundantWithService).toHaveLength(1);
  });

  it('falls back to the deterministic summary when the AI call throws', async () => {
    await writeSkillFixture(skillsDir, 'author', 'style-clone', {
      description: "Analyze the author's voice",
      triggers: ['learn my style'],
    });
    await loader.loadAll();

    const aiComplete: CuratorAICompleteFn = async () => { throw new Error('provider down'); };
    const aiSelectProvider: CuratorAISelectProviderFn = () => ({ id: 'gemini', tier: 'free' });

    const curator = new SkillCuratorService(loader, aiComplete, aiSelectProvider);
    const report = await curator.curate();
    expect(report.aiSummary).toBe(false);
    expect(report.summary).toContain('skill(s)');
  });

  it('skips the AI summary when useAI is false, even if AI is wired', async () => {
    await writeSkillFixture(skillsDir, 'author', 'style-clone', {
      description: "Analyze the author's voice",
      triggers: ['learn my style'],
    });
    await loader.loadAll();
    const aiComplete = vi.fn(async (req: any) => ({ text: 'nope', tokensUsed: 0, estimatedCost: 0, provider: req.provider }));
    const aiSelectProvider: CuratorAISelectProviderFn = () => ({ id: 'gemini', tier: 'free' });
    const curator = new SkillCuratorService(loader, aiComplete as any, aiSelectProvider);
    const report = await curator.curate({ useAI: false });
    expect(aiComplete).not.toHaveBeenCalled();
    expect(report.aiSummary).toBe(false);
  });

  it('handles odd/degenerate input without throwing (skills with empty triggers)', async () => {
    // A skill with a single-char trigger and empty-ish description.
    const dir = join(skillsDir, 'core', 'weird');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      ['---', 'name: weird', 'description: ', 'author: t', 'version: 1.0.0', 'triggers:', '  - "x"', 'permissions:', '  - "memory_read"', '---', '', 'body'].join('\n'),
      'utf-8',
    );
    await loader.loadAll();
    const curator = new SkillCuratorService(loader);
    await expect(curator.curate()).resolves.toBeDefined();
  });
});
