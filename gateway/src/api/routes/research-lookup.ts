/**
 * research-lookup routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';

export function registerResearchLookupRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════

  app.post('/api/research/lookup', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { query, maxWords } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
    try {
      const result = await services.researchLookup.lookup(query, { maxWords });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Research lookup failed' });
    }
  });

  /**
   * Marketing-research presets. Each route maps to a structured preset
   * on ResearchLookupService that builds a tightly-scoped Perplexity
   * query + the safety guardrails (no fake contact info, prefer recent
   * sources, no fabricated names). Result is also persisted to
   * workspace/research/marketing/<topic>-<date>.md so the author can
   * come back to it.
   */
  async function runMarketingPreset(
    topic: string,
    fn: () => Promise<any>,
    res: Response,
  ): Promise<void> {
    try {
      const result = await fn();
      // Persist a markdown copy.
      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const date = new Date().toISOString().split('T')[0];
        const dir = path.join(baseDir, 'workspace', 'research', 'marketing');
        await mkdir(dir, { recursive: true });
        const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const md = `# ${topic}\n\n` +
          `_Generated ${date} via ${result.provider}. ` +
          (result.hasVerifiedSources ? 'Sources verified via live web.' : '⚠️ No live web access — citations may be unreliable.') + '_\n\n' +
          result.answer + '\n';
        await writeFile(path.join(dir, `${slug}-${date}.md`), md, 'utf-8');
      } catch { /* persistence is non-fatal */ }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Research failed' });
    }
  }

  app.post('/api/research/agents', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { genre, subgenre, titleAgePositioning } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre (string) required' });
    return runMarketingPreset(`Literary agents — ${genre}${subgenre ? ' / ' + subgenre : ''}`,
      () => services.researchLookup.findAgents({ genre, subgenre, titleAgePositioning }), res);
  });

  app.post('/api/research/podcasts', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { genre, subgenre } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre (string) required' });
    return runMarketingPreset(`Author podcasts — ${genre}${subgenre ? ' / ' + subgenre : ''}`,
      () => services.researchLookup.findAuthorPodcasts({ genre, subgenre }), res);
  });

  app.post('/api/research/reviewers', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { genre, subgenre, indieFriendly } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre (string) required' });
    return runMarketingPreset(`Book reviewers — ${genre}${subgenre ? ' / ' + subgenre : ''}`,
      () => services.researchLookup.findReviewers({ genre, subgenre, indieFriendly }), res);
  });

  app.post('/api/research/newsletters', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { genre, subgenre } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre (string) required' });
    return runMarketingPreset(`Newsletters — ${genre}${subgenre ? ' / ' + subgenre : ''}`,
      () => services.researchLookup.findNewsletters({ genre, subgenre }), res);
  });

  app.post('/api/research/comp-authors', async (req: Request, res: Response) => {
    if (!services.researchLookup) return res.status(503).json({ error: 'Research lookup not initialized' });
    const { genre, subgenre, tone } = req.body || {};
    if (!genre) return res.status(400).json({ error: 'genre (string) required' });
    return runMarketingPreset(`Comp authors — ${genre}${subgenre ? ' / ' + subgenre : ''}`,
      () => services.researchLookup.findCompAuthors({ genre, subgenre, tone }), res);
  });

}
