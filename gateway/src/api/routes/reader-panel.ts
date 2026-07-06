/**
 * reader-panel routes — Synthetic Reader Panels.
 *
 * POST /api/reader-panel — run a tournament of marketing-asset candidates
 * (blurbs / titles / cover concepts / concepts) against a demographically
 * varied reader panel and return a PanelReport (ranking, winner, confidence,
 * anti-slop warnings).
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerReaderPanelRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;

  app.post('/api/reader-panel', async (req: Request, res: Response) => {
    const svc = services.readerPanel;
    if (!svc) return res.status(503).json({ error: 'Reader panel service not initialized' });

    const { candidates, kind, genre, panelSize, format } = req.body || {};

    // Validate candidates.
    if (!Array.isArray(candidates)) {
      return res.status(400).json({ error: 'candidates (string[]) required' });
    }
    const clean = candidates.map((c: any) => String(c ?? '').trim()).filter(Boolean);
    if (clean.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 non-empty candidates.' });
    }

    // Validate kind.
    const allowedKinds = ['blurb', 'title', 'cover-concept', 'concept'];
    const resolvedKind = allowedKinds.includes(kind) ? kind : 'blurb';

    // Need AI to run the panel.
    if (!services.aiRouter) {
      return res.status(503).json({ error: 'AI router not available — a provider (Ollama/Gemini/etc.) is required to run a panel.' });
    }

    const aiComplete = (request: any) => services.aiRouter.complete(request);
    const aiSelectProvider = (taskType: string) => services.aiRouter.selectProvider(taskType);

    try {
      const report = await svc.runTournament(
        {
          candidates: clean,
          kind: resolvedKind,
          genre: typeof genre === 'string' && genre.trim() ? genre.trim() : 'commercial fiction',
          panelSize: typeof panelSize === 'number' ? panelSize : undefined,
          format: format === 'swiss' ? 'swiss' : 'single-elim',
        },
        aiComplete,
        aiSelectProvider,
      );
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Reader panel tournament failed' });
    }
  });
}
