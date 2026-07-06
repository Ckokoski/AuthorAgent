/**
 * memory-search routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerMemorySearchRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Memory Search (Hermes-inspired FTS5 over conversations + step outputs)
  // ═══════════════════════════════════════════════════════════
  // NOTE: addWaveDisclaimer is imported from ../context.js (shared with
  // wave3-gated.ts and website.ts, matching the original module-scope
  // closure it was originally declared in).

  /**
   * GET /api/memory/search?q=<query>&persona=<id>&project=<id>&source=<src>&limit=<n>
   *   - persona=__active will use the currently-active persona; pass __all to disable filtering.
   * Returns ranked snippets with FTS5 highlighting.
   */
  app.get('/api/memory/search', (req: Request, res: Response) => {
    const search = services.memorySearch;
    if (!search) return res.status(503).json({ error: 'Memory search service not initialized' });
    if (!search.isAvailable()) {
      const stats = search.getStats();
      return res.status(503).json({ error: stats.unavailableReason || 'Search unavailable', stats });
    }
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ hits: [], totalEntries: search.getStats().totalEntries });

    const personaParam = req.query.persona as string | undefined;
    const personaId = personaParam === '__all' ? undefined
      : personaParam === '__active' ? services.memory?.getActivePersonaId() ?? undefined
      : personaParam;

    const projectParam = req.query.project as string | undefined;
    const projectId = projectParam === '__active'
      ? services.memory?.getActiveProjectId() ?? undefined
      : projectParam;

    const hits = search.search(q, {
      limit: req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 25, 100) : 25,
      source: req.query.source as any,
      personaId: personaId ?? undefined,
      projectId,
      fromDate: req.query.fromDate as any,
      toDate: req.query.toDate as any,
    });
    res.json({ hits, query: q, count: hits.length });
  });

  app.get('/api/memory/stats', (_req: Request, res: Response) => {
    const search = services.memorySearch;
    if (!search) return res.status(503).json({ error: 'Memory search not initialized' });
    res.json(search.getStats());
  });

  /** Force a full reindex. Useful after manual edits to conversation files. */
  app.post('/api/memory/reindex', async (_req: Request, res: Response) => {
    const search = services.memorySearch;
    if (!search) return res.status(503).json({ error: 'Memory search not initialized' });
    if (!search.isAvailable()) return res.status(503).json({ error: 'Memory search unavailable' });
    try {
      const result = await search.reindexAll({ force: true });
      res.json({ ...result, stats: search.getStats() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Reindex failed' });
    }
  });

  /**
   * POST /api/memory/consolidate
   * Trigger the sleep-time consolidation job on demand (materializes the
   * CoreDigest + prunes prefs + reindexes/backfills FTS + refreshes the series
   * bible). Body: { projectId?: string } — omit to consolidate every project.
   * All AI calls inside are free-tier only.
   */
  app.post('/api/memory/consolidate', async (req: Request, res: Response) => {
    const sleep = services.sleepConsolidation;
    if (!sleep) return res.status(503).json({ error: 'Sleep consolidation service not initialized' });
    const projectId = req.body?.projectId ? String(req.body.projectId) : undefined;
    try {
      const result = await sleep.run(projectId ? { projectId } : {});
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Consolidation failed' });
    }
  });

  // ─── Active Persona (memory tagging) ───
  // Sets which persona future conversation turns get tagged with so each
  // pen name maintains its own memory boundary in the search index.
  app.get('/api/memory/active-persona', (_req: Request, res: Response) => {
    if (!services.memory) return res.status(503).json({ error: 'Memory not initialized' });
    res.json({
      personaId: services.memory.getActivePersonaId(),
      projectId: services.memory.getActiveProjectId(),
    });
  });

  app.post('/api/memory/active-persona', async (req: Request, res: Response) => {
    if (!services.memory) return res.status(503).json({ error: 'Memory not initialized' });
    const { personaId } = req.body || {};
    // null/empty string clears the active persona (= unscoped memory)
    const value = personaId && typeof personaId === 'string' ? personaId : null;
    await services.memory.setActivePersona(value);
    res.json({ personaId: services.memory.getActivePersonaId() });
  });

  // ═══════════════════════════════════════════════════════════
  // User Model (Honcho-inspired dialectic profile)
}
