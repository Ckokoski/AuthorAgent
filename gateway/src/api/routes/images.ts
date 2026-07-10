/**
 * images routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { safePath } from '../context.js';

export function registerImageRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Image Generation (Together AI + OpenAI)
  // ═══════════════════════════════════════════════════════════

  // Generate an image from a text prompt
  app.post('/api/images/generate', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { prompt, provider, width, height, style } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    try {
      const result = await imageGen.generate(prompt, { provider, width, height, style });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Image generation failed: ' + String(err) });
    }
  });

  // Generate a book cover
  app.post('/api/images/book-cover', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { title, author, genre, description, style,
      subgenre, mood, era, setting, keyImagery, palette, avoidImagery,
      includeText, typographyNote, quality, provider } = req.body;
    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    // Resolve image provider preference: per-call override > global setting > 'auto'
    const resolvedProvider = provider
      || services.config?.get('ai.preferredImageProvider')
      || 'auto';

    try {
      const result = await imageGen.generateBookCover({
        title: title || 'Untitled',
        author: author || 'AuthorAgent',
        genre: genre || 'fiction',
        description,
        style,
        subgenre, mood, era, setting, keyImagery, palette, avoidImagery,
        includeText, typographyNote, quality, provider: resolvedProvider,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Book cover generation failed: ' + String(err) });
    }
  });

  /**
   * POST /api/images/cover-set
   * Generate the full set of standard cover sizes (ebook + print + audiobook
   * + social) in one call, all using the same visual brief so they look
   * cohesive across formats.
   *
   * Body fields (all optional except description):
   *   { title, author, genre, description,
   *     style?, subgenre?, mood?, era?, setting?, keyImagery?, palette?,
   *     avoidImagery?, variants?, quality?, provider? }
   */
  app.post('/api/images/cover-set', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });
    if (!req.body?.description) return res.status(400).json({ error: 'description is required' });

    try {
      const result = await imageGen.generateCoverSet({
        title: req.body.title || 'Untitled',
        author: req.body.author || 'AuthorAgent',
        genre: req.body.genre || 'fiction',
        description: req.body.description,
        style: req.body.style,
        subgenre: req.body.subgenre,
        mood: req.body.mood,
        era: req.body.era,
        setting: req.body.setting,
        keyImagery: req.body.keyImagery,
        palette: req.body.palette,
        avoidImagery: req.body.avoidImagery,
        includeText: req.body.includeText,
        typographyNote: req.body.typographyNote,
        variants: req.body.variants,
        quality: req.body.quality,
        provider: req.body.provider || services.config?.get('ai.preferredImageProvider') || 'auto',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Cover-set generation failed: ' + String(err) });
    }
  });

  /**
   * POST /api/projects/:id/cover-set
   * Same as above but auto-fills title/author/genre/description from the project
   * (using the linked persona for `author` if present).
   */
  app.post('/api/projects/:id/cover-set', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    const engine = gateway.getProjectEngine?.();
    if (!imageGen || !engine) return res.status(503).json({ error: 'Required services not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Resolve author name from linked persona if present.
    let authorName = 'AuthorAgent';
    if ((project as any).personaId && services.personas) {
      const persona = services.personas.get?.((project as any).personaId);
      if (persona?.penName) authorName = persona.penName;
    }

    try {
      const result = await imageGen.generateCoverSet({
        title: project.title,
        author: req.body?.author || authorName,
        genre: req.body?.genre || (project.context?.genre as string) || 'fiction',
        description: req.body?.description || project.description || '',
        style: req.body?.style,
        subgenre: req.body?.subgenre,
        mood: req.body?.mood,
        era: req.body?.era,
        setting: req.body?.setting,
        keyImagery: req.body?.keyImagery,
        palette: req.body?.palette,
        avoidImagery: req.body?.avoidImagery,
        variants: req.body?.variants,
        quality: req.body?.quality,
        provider: req.body?.provider,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Project cover-set generation failed: ' + String(err) });
    }
  });

  /** Return the available cover-variant specs (for the dashboard). */
  app.get('/api/images/cover-variants', async (_req: Request, res: Response) => {
    const { ImageGenService } = await import('../../services/image-gen.js');
    res.json({ variants: ImageGenService.getCoverVariants() });
  });

  // Check available image providers
  app.get('/api/images/providers', async (_req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });
    const providers = await imageGen.getAvailableProviders();
    res.json({ providers });
  });

  // Serve generated images
  app.get('/api/images/:filename', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const imageDir = imageGen.getImageDir();
    const filePath = safePath(imageDir, fname);

    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath) || !fname.match(/^cover-[a-f0-9]+\.png$/)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.sendFile(filePath);
  });

}
