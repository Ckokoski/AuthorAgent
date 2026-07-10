import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine, type ProjectContext, type EntityEntry } from './context-engine.js';
import { MemoryTierService, CORE_BUDGETS, ARCHIVAL_BLOCK_CAP, type CoreDigest } from './memory-tier.js';
import type { SearchHit, SearchOptions } from './memory-search.js';

// ═══════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════

const PROJECT_ID = 'test-project';

function char(
  name: string,
  overrides: Partial<EntityEntry> = {},
): EntityEntry {
  return {
    name,
    type: 'character',
    aliases: [],
    description: `${name} is a character.`,
    firstAppearance: 'ch1',
    lastSeen: 'ch3',
    attributes: {},
    changes: [],
    ...overrides,
  };
}

/**
 * A 3-chapter project:
 *   - Aria: protagonist, recurring across all 3 chapters (baseline top-K).
 *   - Kael: recurring, named in the active chapter summary.
 *   - Mira: recurring supporting character.
 *   - Doran: recurring antagonist.
 *   - Bramble: MINOR — appears ONLY in ch1, never referenced later or in prompt.
 *     Expected to be demoted when over the P2 budget.
 *   - Threads: two open ("the missing heir", "the sealed vault") + one that the
 *     digest will mark resolved ("the storm at sea").
 *   - One world rule entity.
 */
function seedContext(): ProjectContext {
  return {
    projectId: PROJECT_ID,
    updatedAt: new Date().toISOString(),
    summaries: [
      {
        chapterId: 'ch1',
        chapterNumber: 1,
        title: 'The Gathering Storm',
        summary: 'Aria meets Bramble at the docks while the storm at sea rages. Kael watches from afar.',
        wordCount: 3000,
        characters: ['Aria', 'Bramble', 'Kael'],
        locations: ['The Docks'],
        timelineMarker: 'Day 1, dusk',
        plotThreads: ['the storm at sea', 'the missing heir'],
        endingState: 'Aria decides to seek the missing heir despite the danger.',
      },
      {
        chapterId: 'ch2',
        chapterNumber: 2,
        title: 'The Sealed Vault',
        summary: 'Aria and Mira explore the sealed vault. Doran plots against them.',
        wordCount: 3200,
        characters: ['Aria', 'Mira', 'Doran'],
        locations: ['The Vault'],
        timelineMarker: 'Day 3, morning',
        plotThreads: ['the missing heir', 'the sealed vault'],
        endingState: 'The vault door yields, but Doran is waiting on the other side.',
      },
      {
        chapterId: 'ch3',
        chapterNumber: 3,
        title: 'Confrontation',
        // Kael is named in THIS (active) chapter's summary → promoted by mention.
        summary: 'Aria confronts Kael about the missing heir. Mira stands guard.',
        wordCount: 2800,
        characters: ['Aria', 'Kael', 'Mira'],
        locations: ['The Vault'],
        timelineMarker: 'Day 3, evening',
        plotThreads: ['the missing heir', 'the sealed vault'],
        endingState: 'Kael reveals a secret that changes everything.',
      },
    ],
    entities: [
      char('Aria', {
        description: 'A determined dockside courier searching for the truth.',
        attributes: { role: 'protagonist', origin: 'the harbor district' },
        changes: [{ chapterId: 'ch2', description: 'learned to pick locks' }],
      }),
      char('Kael', {
        description: 'A watchful stranger with hidden loyalties.',
        attributes: { role: 'wildcard' },
      }),
      char('Mira', { description: 'A loyal companion and skilled archer.' }),
      char('Doran', {
        type: 'character',
        description: 'A scheming rival lord.',
        attributes: { role: 'antagonist' },
      }),
      char('Bramble', {
        // Minor: only in ch1, never in the active chapter or prompt.
        description: 'A gruff dockhand who points Aria to the docks.',
        firstAppearance: 'ch1',
        lastSeen: 'ch1',
      }),
      {
        name: 'The Balance',
        type: 'rule',
        aliases: [],
        description: 'Magic drawn from the vault must be repaid in equal measure or it consumes the wielder.',
        firstAppearance: 'ch2',
        lastSeen: 'ch3',
        attributes: {},
        changes: [],
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════

let workspaceDir: string;
let engine: ContextEngine;
let tier: MemoryTierService;

/** Write a {projectId}.json fixture into workspace/context and load it. */
async function loadSeed(ctx: ProjectContext): Promise<void> {
  const contextDir = join(workspaceDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, `${ctx.projectId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
  await engine.loadContext(ctx.projectId);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'authoragent-memtier-'));
  engine = new ContextEngine(workspaceDir);
  tier = new MemoryTierService(engine, null, workspaceDir);
});

afterEach(() => {
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════
// ContextEngine getters
// ═══════════════════════════════════════════════════════════

describe('ContextEngine getters (Chunk A)', () => {
  it('getOpenPlotThreads returns the deduped union across summaries', async () => {
    await loadSeed(seedContext());
    const threads = engine.getOpenPlotThreads(PROJECT_ID);
    // Deduped union, first-appearance order.
    expect(threads).toEqual([
      'the storm at sea',
      'the missing heir',
      'the sealed vault',
    ]);
  });

  it('getOpenPlotThreads returns [] when nothing is cached', () => {
    expect(engine.getOpenPlotThreads('nope')).toEqual([]);
  });

  it('getEntitiesByType filters cached entities by type', async () => {
    await loadSeed(seedContext());
    const rules = engine.getEntitiesByType(PROJECT_ID, 'rule');
    expect(rules.map(r => r.name)).toEqual(['The Balance']);
    const chars = engine.getEntitiesByType(PROJECT_ID, 'character');
    expect(chars.map(c => c.name).sort()).toEqual(
      ['Aria', 'Bramble', 'Doran', 'Kael', 'Mira'],
    );
  });

  it('getEntitiesByType returns [] when nothing is cached', () => {
    expect(engine.getEntitiesByType('nope', 'character')).toEqual([]);
  });

  it('getSummaries returns [] when nothing is cached', () => {
    expect(engine.getSummaries('nope')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// buildCore — budget + priority
// ═══════════════════════════════════════════════════════════

describe('MemoryTierService.buildCore', () => {
  it('returns "" when nothing is cached (never throws)', () => {
    // No fixture loaded → empty context.
    expect(() => tier.buildCore('unknown-project', 1, 'anything')).not.toThrow();
    expect(tier.buildCore('unknown-project', 1, 'anything')).toBe('');
  });

  it('produces a CORE block clamped to <= 3500 chars', async () => {
    await loadSeed(seedContext());
    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');
    expect(core.length).toBeLessThanOrEqual(CORE_BUDGETS.total);
    expect(core.length).toBeLessThanOrEqual(3500);
  });

  it('emits sections in priority order (P1 → P2 → P3 → P4 → P5)', async () => {
    // Provide a style digest so P4 is present.
    tier.writeCoreDigest(PROJECT_ID, { styleDigest: 'Terse, sensory, past tense.' });
    await loadSeed(seedContext());

    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');

    const iActive = core.indexOf('Active Chapter State');
    const iChars = core.indexOf('Key Characters');
    const iThreads = core.indexOf('Open Plot Threads');
    const iStyle = core.indexOf('Style Digest');
    const iRules = core.indexOf('World Rules');

    // All present in this fixture.
    for (const [label, idx] of Object.entries({ iActive, iChars, iThreads, iStyle, iRules })) {
      expect(idx, `${label} should be present`).toBeGreaterThanOrEqual(0);
    }
    // Strictly increasing → priority order preserved.
    expect(iActive).toBeLessThan(iChars);
    expect(iChars).toBeLessThan(iThreads);
    expect(iThreads).toBeLessThan(iStyle);
    expect(iStyle).toBeLessThan(iRules);
  });

  it('skips empty slots silently without error', async () => {
    // A minimal context: one chapter, no rule entity, no plot threads, no
    // characters. P2/P3/P5 slots are empty and must be skipped, not errored.
    const minimal: ProjectContext = {
      projectId: PROJECT_ID,
      updatedAt: new Date().toISOString(),
      summaries: [
        {
          chapterId: 'ch1',
          chapterNumber: 1,
          title: 'Alone',
          summary: 'A quiet opening.',
          wordCount: 500,
          characters: [],
          locations: [],
          timelineMarker: 'Day 1',
          plotThreads: [],
          endingState: 'Nothing has happened yet.',
        },
      ],
      entities: [],
    };
    await loadSeed(minimal);

    let core = '';
    expect(() => { core = tier.buildCore(PROJECT_ID, 1, 'begin'); }).not.toThrow();
    // P1 present, empty slots absent.
    expect(core).toContain('Active Chapter State');
    expect(core).not.toContain('Key Characters');
    expect(core).not.toContain('Open Plot Threads');
    expect(core).not.toContain('World Rules');
  });

  it('includes the active chapter state (P1)', async () => {
    await loadSeed(seedContext());
    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');
    // Active chapter is 3 → P1 shows the prior completed chapter (ch2) state.
    expect(core).toContain('Active Chapter State');
    expect(core).toContain('The vault door yields');
  });

  it('includes the world rule entity in P5', async () => {
    await loadSeed(seedContext());
    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');
    expect(core).toContain('World Rules');
    expect(core).toContain('The Balance');
  });
});

// ═══════════════════════════════════════════════════════════
// PROMOTE / DEMOTE
// ═══════════════════════════════════════════════════════════

describe('MemoryTierService.getPromotedSet', () => {
  it('promotes a character named in the prompt', async () => {
    await loadSeed(seedContext());
    // Doran is NOT in the active (ch3) summary, but IS named in the prompt.
    const promoted = tier.getPromotedSet(PROJECT_ID, 3, 'What is Doran planning next?');
    expect(promoted.map(c => c.name)).toContain('Doran');
  });

  it('promotes a character named in the active chapter summary', async () => {
    await loadSeed(seedContext());
    // Kael appears in ch3's summary text even if not in the prompt.
    const promoted = tier.getPromotedSet(PROJECT_ID, 3, 'begin the scene');
    expect(promoted.map(c => c.name)).toContain('Kael');
  });

  it('includes the baseline top-K most-recurring characters', async () => {
    await loadSeed(seedContext());
    const promoted = tier.getPromotedSet(PROJECT_ID, 3, 'begin the scene');
    // Aria appears in all 3 chapters → always in baseline top-K.
    expect(promoted.map(c => c.name)).toContain('Aria');
  });

  it('excludes an unreferenced minor character when over budget', async () => {
    // Force the P2 budget to bite: give every character a very long arc via the
    // digest so the rendered sheets exceed 1400 chars and demotion kicks in.
    const longArc = 'x'.repeat(400);
    const digest: CoreDigest = {
      arcs: {
        Aria: longArc, Kael: longArc, Mira: longArc, Doran: longArc, Bramble: longArc,
      },
    };
    tier.writeCoreDigest(PROJECT_ID, digest);
    await loadSeed(seedContext());

    const promoted = tier.getPromotedSet(PROJECT_ID, 3, 'Aria confronts Kael and Doran');
    const names = promoted.map(c => c.name);
    // Bramble (only in ch1, never referenced) is the lowest-relevance sheet and
    // must be dropped first under budget pressure.
    expect(names).not.toContain('Bramble');
    // Referenced characters survive.
    expect(names).toContain('Aria');
    expect(names).toContain('Kael');
  });

  it('caps the promoted set and its rendered block within the P2 budget', async () => {
    const longArc = 'y'.repeat(400);
    const digest: CoreDigest = {
      arcs: { Aria: longArc, Kael: longArc, Mira: longArc, Doran: longArc, Bramble: longArc },
    };
    tier.writeCoreDigest(PROJECT_ID, digest);
    await loadSeed(seedContext());

    const promoted = tier.getPromotedSet(PROJECT_ID, 3, 'Aria Kael Mira Doran');
    // Rendered sheet body must fit the P2 budget.
    const rendered = promoted
      .map(c => {
        const arc = digest.arcs?.[c.name];
        return `- **${c.name}**: ${arc || c.description}`;
      })
      .join('\n');
    expect(rendered.length).toBeLessThanOrEqual(CORE_BUDGETS.p2CharacterSheets);
  });

  it('returns [] when there are no characters', async () => {
    const noChars: ProjectContext = {
      projectId: PROJECT_ID,
      updatedAt: new Date().toISOString(),
      summaries: [],
      entities: [],
    };
    await loadSeed(noChars);
    expect(tier.getPromotedSet(PROJECT_ID, 1, 'anything')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// Core digest round-trip + style precedence
// ═══════════════════════════════════════════════════════════

describe('MemoryTierService core digest', () => {
  it('write → read round-trips the digest', () => {
    const digest: CoreDigest = {
      styleDigest: 'Lean prose, active voice.',
      openThreads: ['the missing heir'],
      resolvedThreads: ['the storm at sea'],
      promotedBaseline: ['Aria', 'Kael'],
      arcs: { Aria: 'Grows from courier to leader.' },
      computedAt: '2026-01-01T00:00:00.000Z',
    };
    tier.writeCoreDigest(PROJECT_ID, digest);
    const read = tier.loadCoreDigest(PROJECT_ID);
    expect(read).not.toBeNull();
    expect(read).toEqual(digest);
  });

  it('stamps computedAt when the caller omits it', () => {
    tier.writeCoreDigest(PROJECT_ID, { styleDigest: 'Brisk.' });
    const read = tier.loadCoreDigest(PROJECT_ID);
    expect(read?.computedAt).toBeTruthy();
  });

  it('writes atomically (no lingering .tmp file, valid JSON on disk)', () => {
    tier.writeCoreDigest(PROJECT_ID, { styleDigest: 'Atomic.' });
    const raw = readFileSync(join(workspaceDir, 'context', `${PROJECT_ID}-core.json`), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('loadCoreDigest returns null on a missing file (never throws)', () => {
    expect(() => tier.loadCoreDigest('no-such-project')).not.toThrow();
    expect(tier.loadCoreDigest('no-such-project')).toBeNull();
  });

  it('loadCoreDigest returns null on malformed JSON (never throws)', () => {
    const dir = join(workspaceDir, 'context');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${PROJECT_ID}-core.json`), '{ not valid json', 'utf-8');
    expect(() => tier.loadCoreDigest(PROJECT_ID)).not.toThrow();
    expect(tier.loadCoreDigest(PROJECT_ID)).toBeNull();
  });

  it('digest styleDigest takes precedence over the STYLE-GUIDE.md fallback', async () => {
    // Write a STYLE-GUIDE.md fallback...
    const soulDir = join(workspaceDir, 'soul');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(join(soulDir, 'STYLE-GUIDE.md'), 'FALLBACK STYLE FROM FILE', 'utf-8');
    // ...and a digest styleDigest that should win.
    tier.writeCoreDigest(PROJECT_ID, { styleDigest: 'DIGEST STYLE WINS' });
    await loadSeed(seedContext());

    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');
    expect(core).toContain('DIGEST STYLE WINS');
    expect(core).not.toContain('FALLBACK STYLE FROM FILE');
  });

  it('falls back to STYLE-GUIDE.md (first 600 chars) when no digest style', async () => {
    const soulDir = join(workspaceDir, 'soul');
    mkdirSync(soulDir, { recursive: true });
    const longStyle = 'STYLE START ' + 'z'.repeat(2000) + ' STYLE END';
    writeFileSync(join(soulDir, 'STYLE-GUIDE.md'), longStyle, 'utf-8');
    // No digest at all.
    await loadSeed(seedContext());

    const core = tier.buildCore(PROJECT_ID, 3, 'Aria confronts Kael');
    expect(core).toContain('Style Digest');
    expect(core).toContain('STYLE START');
    // The 600-char cap means the far-end "STYLE END" marker never makes it in.
    expect(core).not.toContain('STYLE END');
  });
});

// ═══════════════════════════════════════════════════════════
// searchArchival (Chunk B1)
// ═══════════════════════════════════════════════════════════

/**
 * Minimal fake MemorySearchService — MemoryTierService.searchArchival only
 * calls isAvailable() and search(). Records the queries/opts it receives so
 * tests can assert on scoping.
 */
class FakeSearch {
  available = true;
  calls: Array<{ query: string; opts: SearchOptions }> = [];
  constructor(private hits: SearchHit[] = []) {}
  isAvailable(): boolean { return this.available; }
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    this.calls.push({ query, opts });
    // Emulate single-source filtering so the multi-source merge path is exercised.
    if (opts.source) return this.hits.filter(h => h.source === opts.source);
    return this.hits;
  }
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id: 1,
    source: 'manuscript',
    sourceRef: 'my-novel/manuscript.md',
    personaId: null,
    projectId: 'test-project',
    timestamp: '2026-03-14T12:00:00.000Z',
    title: 'The Sealed Vault',
    snippet: 'Aria pressed her palm to the [vault] door and felt it yield…',
    rank: -1.0,
    ...overrides,
  };
}

describe('MemoryTierService.searchArchival', () => {
  it('returns "" when memorySearch is null (guard: exact prior behavior)', () => {
    const t = new MemoryTierService(engine, null, workspaceDir);
    expect(t.searchArchival('anything', { limit: 6 })).toBe('');
  });

  it('returns "" when memorySearch is unavailable', () => {
    const fake = new FakeSearch([hit()]);
    fake.available = false;
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    expect(t.searchArchival('vault', { limit: 6 })).toBe('');
  });

  it('returns "" on an empty query without calling search', () => {
    const fake = new FakeSearch([hit()]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    expect(t.searchArchival('   ', { limit: 6 })).toBe('');
    expect(fake.calls.length).toBe(0);
  });

  it('returns "" when there are no hits', () => {
    const fake = new FakeSearch([]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    expect(t.searchArchival('nothing matches', { limit: 6 })).toBe('');
  });

  it('formats hits under the labeled header with title, snippet, source, and date', () => {
    const fake = new FakeSearch([hit()]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    const block = t.searchArchival('vault', { limit: 6, sources: ['manuscript'] });
    expect(block).toContain('# From Your Manuscript & Past Work');
    expect(block).toContain('## The Sealed Vault');       // title
    expect(block).toContain('Aria pressed her palm');     // snippet
    expect(block).toContain('Source: manuscript');        // source-type label
    expect(block).toContain('2026-03-14');                // date (YYYY-MM-DD)
  });

  it('labels project_step hits distinctly from manuscript hits', () => {
    const fake = new FakeSearch([
      hit({ id: 2, source: 'project_step', title: 'Consistency check', timestamp: '2026-02-01T00:00:00Z' }),
    ]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    const block = t.searchArchival('consistency', { limit: 6 });
    expect(block).toContain('Source: project step');
  });

  it('hard-caps the block at ARCHIVAL_BLOCK_CAP with whole-hit-or-skip', () => {
    // 20 fat hits — far more than can fit in 2,000 chars.
    const big = Array.from({ length: 20 }, (_, i) =>
      hit({ id: i + 1, title: `Chapter ${i + 1}`, snippet: 'q'.repeat(400), rank: -20 + i }),
    );
    const fake = new FakeSearch(big);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    const block = t.searchArchival('anything', { limit: 20 });
    expect(block.length).toBeLessThanOrEqual(ARCHIVAL_BLOCK_CAP);
    // whole-hit-or-skip: no truncation marker mid-hit — every rendered snippet
    // is the full 400 chars, so the block never ends mid-"q"-run + "…cut".
    expect(block).toContain('# From Your Manuscript & Past Work');
  });

  it('respects an explicit lower maxChars budget', () => {
    const big = Array.from({ length: 10 }, (_, i) =>
      hit({ id: i + 1, title: `Ch ${i + 1}`, snippet: 'z'.repeat(200), rank: -10 + i }),
    );
    const fake = new FakeSearch(big);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    const block = t.searchArchival('anything', { limit: 10, maxChars: 400 });
    expect(block.length).toBeLessThanOrEqual(400);
  });

  it('merges multi-source results and de-dupes by hit id, best rank wins', () => {
    // Same id returned from two source queries with different ranks.
    const fake = new FakeSearch([
      hit({ id: 7, source: 'manuscript', rank: -0.5 }),
      hit({ id: 8, source: 'project_step', title: 'Step 8', rank: -2.0 }),
    ]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    const block = t.searchArchival('vault', { limit: 6, sources: ['manuscript', 'project_step'] });
    // Both distinct hits present.
    expect(block).toContain('The Sealed Vault');
    expect(block).toContain('Step 8');
    // Ran one query per source.
    const sources = fake.calls.map(c => c.opts.source);
    expect(sources).toContain('manuscript');
    expect(sources).toContain('project_step');
  });

  it('passes projectId scoping through to search', () => {
    const fake = new FakeSearch([hit()]);
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    t.searchArchival('vault', { limit: 6, projectId: 'test-project', sources: ['manuscript'] });
    expect(fake.calls[0].opts.projectId).toBe('test-project');
  });

  it('never throws when search() throws — degrades to ""', () => {
    const fake = new FakeSearch([hit()]);
    fake.search = () => { throw new Error('FTS syntax error'); };
    const t = new MemoryTierService(engine, fake as any, workspaceDir);
    expect(() => t.searchArchival('bad(query', { limit: 6 })).not.toThrow();
    expect(t.searchArchival('bad(query', { limit: 6 })).toBe('');
  });
});
