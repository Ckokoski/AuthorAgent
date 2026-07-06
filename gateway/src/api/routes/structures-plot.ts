/**
 * structures-plot routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerStructuresPlotRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Story Structures (smart-recommend, not forced)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/structures', (_req: Request, res: Response) => {
    if (!services.storyStructures) return res.status(503).json({ error: 'Not initialized' });
    res.json({ structures: services.storyStructures.list() });
  });

  app.post('/api/structures/recommend', (req: Request, res: Response) => {
    if (!services.storyStructures) return res.status(503).json({ error: 'Not initialized' });
    const { genre, subgenre, description } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre required' });
    res.json(services.storyStructures.recommend({ genre, subgenre, description }));
  });

  app.post('/api/structures/check-outline', (req: Request, res: Response) => {
    if (!services.storyStructures) return res.status(503).json({ error: 'Not initialized' });
    const { outline, structureId } = req.body || {};
    if (!Array.isArray(outline) || outline.some((c: any) => typeof c !== 'string')) {
      return res.status(400).json({ error: 'outline must be array of chapter summary strings' });
    }
    if (!structureId) return res.status(400).json({ error: 'structureId required' });
    const report = services.storyStructures.checkOutline(outline, structureId);
    if (!report) return res.status(404).json({ error: 'Unknown structureId' });
    res.json(report);
  });

  /**
   * Combined endpoint: from a project's outline, get recommendations AND
   * (optionally) run an outline check against the project's chosen structure.
   */
  app.post('/api/projects/:id/structure-check', async (req: Request, res: Response) => {
    if (!services.storyStructures) return res.status(503).json({ error: 'Not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Pull outline summaries from the project's completed outline-phase steps.
    const outlineSteps = project.steps.filter((s: any) =>
      (s.phase === 'outline' || s.skill === 'outline') && s.status === 'completed' && s.result);
    const outline: string[] = outlineSteps.length > 0
      ? outlineSteps.flatMap((s: any) => {
          // Try to split by chapter-N headings — fall back to one entry per step.
          const chunks = String(s.result).split(/\n##\s+(?:Chapter\s+)?\d+/i);
          return chunks.length > 1 ? chunks.slice(1).map(c => c.trim()) : [String(s.result)];
        })
      : (req.body?.outline || []);

    const genre = (project.context?.genre as string) || req.body?.genre || 'fiction';
    const subgenre = (project.context?.subgenre as string) || req.body?.subgenre;
    const description = project.description || '';

    const recommendation = services.storyStructures.recommend({ genre, subgenre, description });
    const chosenId = req.body?.structureId
      || (project.context?.structureId as string)
      || recommendation.recommended[0]?.structureId;

    let outlineCheck = null;
    if (chosenId && outline.length > 0) {
      outlineCheck = services.storyStructures.checkOutline(outline, chosenId);
    }

    res.json({ recommendation, chosenStructureId: chosenId, outlineCheck, outlineUsed: outline.length });
  });

  // ═══════════════════════════════════════════════════════════
  // Plot Promises (Sanderson-style promises + payoffs)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/:id/plot-promises', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    res.json(await services.plotPromises.getPromises(req.params.id));
  });

  app.post('/api/projects/:id/plot-promises/extract', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Default: extract from chapters 1-3 if completed; allow override via body.openingText
    let openingText = req.body?.openingText as string | undefined;
    if (!openingText) {
      const writingSteps = project.steps
        .filter((s: any) => s.skill === 'write' && s.status === 'completed' && s.result)
        .slice(0, 3);
      openingText = writingSteps.map((s: any) => String(s.result)).join('\n\n---\n\n');
    }
    if (!openingText || openingText.length < 500) {
      return res.status(400).json({
        error: 'No opening chapter content found. Complete the first 1-3 chapters first, OR pass `openingText` in the body.',
      });
    }

    try {
      const result = await services.plotPromises.extractFromOpening({
        projectId: req.params.id,
        openingChapterText: openingText,
        aiComplete: (r: any) => services.aiRouter.complete(r),
        aiSelectProvider: (taskType: string) => services.aiRouter.selectProvider(taskType),
        merge: req.body?.merge !== false,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Extraction failed' });
    }
  });

  app.patch('/api/projects/:id/plot-promises/:promiseId', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    const updated = await services.plotPromises.updatePromise(req.params.id, req.params.promiseId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Promise not found' });
    res.json(updated);
  });

  app.delete('/api/projects/:id/plot-promises/:promiseId', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    const removed = await services.plotPromises.deletePromise(req.params.id, req.params.promiseId);
    res.json({ success: removed });
  });

  app.post('/api/projects/:id/plot-promises', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    try {
      const promise = await services.plotPromises.addPromise(req.params.id, {
        title: req.body.title,
        description: req.body.description,
        category: req.body.category || 'other',
        introducedAtChapter: req.body.introducedAtChapter || 1,
        confidence: req.body.confidence ?? 1,
        status: req.body.status || 'open',
        authorNotes: req.body.authorNotes || '',
        authorConfirmed: true,
      });
      res.json(promise);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Add failed' });
    }
  });

  app.get('/api/projects/:id/plot-promises/audit', async (req: Request, res: Response) => {
    if (!services.plotPromises) return res.status(503).json({ error: 'Not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    const progressPct = project?.progress ?? Number(req.query.progress) ?? 100;
    const riskThreshold = Number(req.query.riskThreshold) || 80;
    res.json(await services.plotPromises.audit(req.params.id, progressPct, riskThreshold));
  });

}
