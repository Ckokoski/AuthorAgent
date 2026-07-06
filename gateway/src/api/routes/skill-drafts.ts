/**
 * skill-drafts routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerSkillDraftRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════

  app.get('/api/skill-drafts', (req: Request, res: Response) => {
    if (!services.autoSkill) return res.status(503).json({ error: 'Auto-skill not initialized' });
    const status = req.query.status as any;
    res.json({ drafts: services.autoSkill.list(status ? { status } : undefined) });
  });

  app.get('/api/skill-drafts/:id', (req: Request, res: Response) => {
    if (!services.autoSkill) return res.status(503).json({ error: 'Auto-skill not initialized' });
    const draft = services.autoSkill.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json({ draft });
  });

  app.post('/api/skill-drafts/:id/accept', async (req: Request, res: Response) => {
    if (!services.autoSkill) return res.status(503).json({ error: 'Auto-skill not initialized' });
    const category = req.body?.category;
    const result = await services.autoSkill.accept(req.params.id, category ? { category } : {});
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/skill-drafts/:id/reject', async (req: Request, res: Response) => {
    if (!services.autoSkill) return res.status(503).json({ error: 'Auto-skill not initialized' });
    const result = await services.autoSkill.reject(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  });

  /** Manually request a draft from any completed project. */
  app.post('/api/projects/:id/draft-skill', async (req: Request, res: Response) => {
    if (!services.autoSkill) return res.status(503).json({ error: 'Auto-skill not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const draft = await services.autoSkill.draftFromProject({
        id: project.id, type: project.type, title: project.title,
        description: project.description, steps: project.steps,
      }, 'user-request');
      if (!draft) return res.status(400).json({ error: 'Draft generation failed (AI provider issue or no completed steps)' });
      res.json({ draft });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Draft failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Writing Judge — manual evaluation endpoint
}
