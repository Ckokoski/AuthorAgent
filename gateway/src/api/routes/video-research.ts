/**
 * video-research routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerVideoResearchRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Video Research — yt-dlp + transcript + AI notes
  // ═══════════════════════════════════════════════════════════

  app.get('/api/video/doctor', async (_req: Request, res: Response) => {
    if (!services.videoResearch) return res.status(503).json({ error: 'Video research not initialized' });
    res.json(await services.videoResearch.doctor());
  });

  app.post('/api/video/extract', async (req: Request, res: Response) => {
    if (!services.videoResearch) return res.status(503).json({ error: 'Video research not initialized' });
    const { url, topic } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url (string) required' });
    if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'topic (string) required — what you\'re researching' });
    try {
      const result = await services.videoResearch.extract(url, topic);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Video extraction failed' });
    }
  });

}
