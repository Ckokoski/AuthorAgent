/**
 * judge-character-voices routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerJudgeCharacterVoiceRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════

  /**
   * POST /api/judge { text, runLLMJudge?, threshold?, mechanicalWeight? }
   *   Score arbitrary prose. The judge runs automatically inside the project
   *   pipeline; this endpoint lets the user (or scripts) score loose text.
   */
  app.post('/api/judge', async (req: Request, res: Response) => {
    if (!services.writingJudge) return res.status(503).json({ error: 'Writing judge not initialized' });
    const { text, runLLMJudge, threshold, mechanicalWeight, dualJudge } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) required' });
    try {
      const verdict = await services.writingJudge.evaluate(text, {
        aiComplete: runLLMJudge !== false ? (r: any) => services.aiRouter.complete(r) : undefined,
        aiSelectProvider: runLLMJudge !== false ? (taskType: string) => services.aiRouter.selectProvider(taskType) : undefined,
        threshold,
        mechanicalWeight,
        runLLMJudge: runLLMJudge !== false,
        dualJudge: dualJudge === true,
      });
      res.json(verdict);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Evaluation failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Per-character voice fingerprinting + drift detection
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/:id/character-voices', async (req: Request, res: Response) => {
    if (!services.characterVoices) return res.status(503).json({ error: 'Not initialized' });
    res.json(await services.characterVoices.getProjectVoices(req.params.id));
  });

  /** Ingest a chapter's dialogue into the per-character corpus, refresh
   *  fingerprints if any character crossed the threshold. */
  app.post('/api/projects/:id/character-voices/ingest', async (req: Request, res: Response) => {
    if (!services.characterVoices) return res.status(503).json({ error: 'Not initialized' });
    const { chapterNumber, chapterText, characterNames, characterAliases } = req.body || {};
    if (!chapterText || typeof chapterText !== 'string') {
      return res.status(400).json({ error: 'chapterText (string) required' });
    }
    if (!Array.isArray(characterNames)) {
      return res.status(400).json({ error: 'characterNames (array) required' });
    }
    try {
      const result = await services.characterVoices.ingestChapter({
        projectId: req.params.id,
        chapterNumber: Number(chapterNumber) || 1,
        chapterText,
        characterNames,
        characterAliases: characterAliases || {},
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Ingestion failed' });
    }
  });

  /** Score a single chapter for character-voice drift against built fingerprints. */
  app.post('/api/projects/:id/character-voices/detect-drift', async (req: Request, res: Response) => {
    if (!services.characterVoices) return res.status(503).json({ error: 'Not initialized' });
    const { chapterNumber, chapterText, characterNames, characterAliases } = req.body || {};
    if (!chapterText || typeof chapterText !== 'string') {
      return res.status(400).json({ error: 'chapterText (string) required' });
    }
    if (!Array.isArray(characterNames)) {
      return res.status(400).json({ error: 'characterNames (array) required' });
    }
    try {
      const report = await services.characterVoices.detectDrift({
        projectId: req.params.id,
        chapterNumber: Number(chapterNumber) || 1,
        chapterText,
        characterNames,
        characterAliases: characterAliases || {},
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Drift detection failed' });
    }
  });

  /** GET /api/judge/screen?text=... — mechanical screen only (no AI cost). */
  app.get('/api/judge/screen', (req: Request, res: Response) => {
    if (!services.writingJudge) return res.status(503).json({ error: 'Writing judge not initialized' });
    const text = String(req.query.text || '');
    if (!text) return res.status(400).json({ error: 'text query param required' });
    res.json(services.writingJudge.mechanicalScreen(text));
  });

  // ═══════════════════════════════════════════════════════════
  // Research Lookup — sourced research via Perplexity
}
