/**
 * user-model routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerUserModelRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════

  app.get('/api/user-model', (_req: Request, res: Response) => {
    if (!services.userModel) return res.status(503).json({ error: 'User model not initialized' });
    res.json({ snapshot: services.userModel.getSnapshot() });
  });

  app.post('/api/user-model/consolidate', async (_req: Request, res: Response) => {
    if (!services.userModel) return res.status(503).json({ error: 'User model not initialized' });
    try {
      const snap = await services.userModel.maybeConsolidate(true);
      if (!snap) return res.status(503).json({ error: 'No AI provider available for consolidation' });
      res.json({ snapshot: snap });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Consolidation failed' });
    }
  });

  app.delete('/api/user-model', async (_req: Request, res: Response) => {
    if (!services.userModel) return res.status(503).json({ error: 'User model not initialized' });
    await services.userModel.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Cron Scheduler
}
