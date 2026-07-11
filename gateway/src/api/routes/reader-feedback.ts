/**
 * reader-feedback routes — the Reader-Feedback Moat.
 *
 * Per-project config + live public-serialization ingestion (Royal Road; Wattpad
 * stubbed) so the next chapter is written against real reader-reaction data.
 *
 *   GET  /api/projects/:id/reader-feedback/config  — read config
 *   POST /api/projects/:id/reader-feedback/config  — set/merge config
 *   POST /api/projects/:id/reader-feedback/sync    — run live ingestion
 *   GET  /api/projects/:id/reader-feedback/report  — cached report
 *
 * Matches the ApiContext registerXRoutes(ctx) pattern of the other route
 * modules. Guards: 503 (service not initialized), 404 (unknown project),
 * 400 (bad input).
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerReaderFeedbackRoutes(ctx: ApiContext): void {
  const { app, gateway, services } = ctx;

  /** Resolve the project engine + verify the project exists. Returns null +
   *  sends the appropriate error response when it can't proceed. */
  function requireService(res: Response): boolean {
    if (!services.readerFeedback) {
      res.status(503).json({ error: 'Reader feedback service not initialized' });
      return false;
    }
    return true;
  }

  function projectExists(id: string): boolean {
    try {
      const engine = gateway.getProjectEngine ? gateway.getProjectEngine() : null;
      if (!engine || typeof engine.getProject !== 'function') return true; // can't verify → don't block
      return Boolean(engine.getProject(id));
    } catch {
      return true; // verification failure shouldn't block the feature
    }
  }

  // ── GET config ──
  app.get('/api/projects/:id/reader-feedback/config', (req: Request, res: Response) => {
    if (!requireService(res)) return;
    const id = String(req.params.id);
    if (!projectExists(id)) return res.status(404).json({ error: `Project not found: ${id}` });
    const config = services.readerFeedback.getConfig(id);
    res.json({ config });
  });

  // ── POST config (set/merge) ──
  app.post('/api/projects/:id/reader-feedback/config', async (req: Request, res: Response) => {
    if (!requireService(res)) return;
    const id = String(req.params.id);
    if (!projectExists(id)) return res.status(404).json({ error: `Project not found: ${id}` });
    const { platform, fictionUrl, enabled } = req.body || {};
    try {
      const config = await services.readerFeedback.setConfig(id, { platform, fictionUrl, enabled });
      res.json({ config });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Invalid reader-feedback config' });
    }
  });

  // ── POST sync (live ingestion) ──
  app.post('/api/projects/:id/reader-feedback/sync', async (req: Request, res: Response) => {
    if (!requireService(res)) return;
    const id = String(req.params.id);
    if (!projectExists(id)) return res.status(404).json({ error: `Project not found: ${id}` });
    if (!services.readerFeedback.getConfig(id)) {
      return res.status(400).json({ error: 'No reader-feedback config for this project. POST a config first.' });
    }
    try {
      const report = await services.readerFeedback.sync(id);
      res.json({ report });
    } catch (err: any) {
      // sync() never throws by contract, but guard anyway.
      res.status(500).json({ error: err?.message || 'Reader-feedback sync failed' });
    }
  });

  // ── GET report (cached) ──
  app.get('/api/projects/:id/reader-feedback/report', (req: Request, res: Response) => {
    if (!requireService(res)) return;
    const id = String(req.params.id);
    if (!projectExists(id)) return res.status(404).json({ error: `Project not found: ${id}` });
    const report = services.readerFeedback.getReport(id);
    if (!report) return res.status(404).json({ error: 'No cached report — run a sync first.' });
    res.json({ report });
  });
}
