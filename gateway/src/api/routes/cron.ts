/**
 * cron routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerCronRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════

  app.get('/api/cron', (_req: Request, res: Response) => {
    if (!services.cronScheduler) return res.status(503).json({ error: 'Cron not initialized' });
    res.json({
      jobs: services.cronScheduler.list(),
      handlers: services.cronScheduler.listHandlers(),
    });
  });

  app.post('/api/cron', async (req: Request, res: Response) => {
    if (!services.cronScheduler) return res.status(503).json({ error: 'Cron not initialized' });
    const { name, schedule, handler, payload, enabled } = req.body || {};
    if (!name || !schedule || !handler) {
      return res.status(400).json({ error: 'name, schedule, handler required' });
    }
    try {
      const job = await services.cronScheduler.createJob({ name, schedule, handler, payload, enabled });
      res.json({ job });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Job creation failed' });
    }
  });

  app.patch('/api/cron/:id', async (req: Request, res: Response) => {
    if (!services.cronScheduler) return res.status(503).json({ error: 'Cron not initialized' });
    try {
      const job = await services.cronScheduler.updateJob(req.params.id, req.body || {});
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json({ job });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Update failed' });
    }
  });

  app.delete('/api/cron/:id', async (req: Request, res: Response) => {
    if (!services.cronScheduler) return res.status(503).json({ error: 'Cron not initialized' });
    const removed = await services.cronScheduler.deleteJob(req.params.id);
    res.json({ success: removed });
  });

  app.post('/api/cron/:id/run-now', async (req: Request, res: Response) => {
    if (!services.cronScheduler) return res.status(503).json({ error: 'Cron not initialized' });
    const result = await services.cronScheduler.runNow(req.params.id);
    res.json(result);
  });

  app.post('/api/cron/validate', async (req: Request, res: Response) => {
    const { validateCronExpression } = await import('../../services/cron-scheduler.js');
    const { schedule } = req.body || {};
    if (!schedule) return res.status(400).json({ error: 'schedule required' });
    res.json(validateCronExpression(schedule));
  });

  // ═══════════════════════════════════════════════════════════
  // Auto-Skill Drafts (review before promotion to skills/ops/)
}
