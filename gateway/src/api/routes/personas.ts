/**
 * personas routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerPersonaRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Author Personas
  // ═══════════════════════════════════════════════════════════
  // IMPORTANT: Static routes (/generate) must be defined BEFORE parameterized routes (/:id)
  // to prevent Express from matching "generate" as an :id parameter.

  app.get('/api/personas', (_req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    res.json({ personas: personas.list() });
  });

  // AI-assisted full persona generation (static route — must precede /:id)
  app.post('/api/personas/generate', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const { genre, description } = req.body;
    if (!genre) return res.status(400).json({ error: 'genre is required' });

    try {
      const provider = services.aiRouter?.selectProvider('general');
      if (!provider) return res.status(503).json({ error: 'No AI provider available. Configure an API key in Settings first.' });
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a publishing industry expert. Return ONLY valid JSON, no markdown.',
        messages: [{
          role: 'user' as const,
          content: `Create an author persona for someone who writes ${genre}. ${description || ''}\n\nReturn JSON with these fields:\n- penName: a believable pen name for this genre\n- genre: the main genre\n- subGenre: a specific subgenre\n- voiceDescription: 1-2 sentences describing their writing voice/style\n- styleMarkers: array of 3-5 style descriptors (e.g. "witty dialogue", "slow burn")\n- bio: a 2-3 sentence author bio in third person\n\nReturn ONLY the JSON object.`,
        }],
        maxTokens: 500,
      });
      if (result.text) {
        const cleaned = result.text.replace(/```json\n?|```\n?/g, '').trim();
        const generated = JSON.parse(cleaned);
        const persona = await personas.create({
          penName: generated.penName || 'New Author',
          genre: generated.genre || genre,
          subGenre: generated.subGenre || '',
          voiceDescription: generated.voiceDescription || '',
          styleMarkers: generated.styleMarkers || [],
          bio: generated.bio || '',
        });
        res.status(201).json(persona);
      } else {
        res.status(500).json({ error: 'AI returned empty response' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate persona: ' + String(err) });
    }
  });

  // Create persona (static route — must precede /:id)
  app.post('/api/personas', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const { penName } = req.body;
    if (!penName || typeof penName !== 'string') {
      return res.status(400).json({ error: 'penName is required' });
    }
    try {
      const persona = await personas.create(req.body);
      res.status(201).json(persona);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create persona: ' + String(err) });
    }
  });

  // Parameterized persona routes (/:id)
  app.get('/api/personas/:id', (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const persona = personas.get(req.params.id);
    if (!persona) return res.status(404).json({ error: 'Persona not found' });
    res.json(persona);
  });

  app.put('/api/personas/:id', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    try {
      const updated = await personas.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Persona not found' });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update persona: ' + String(err) });
    }
  });

  app.delete('/api/personas/:id', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const deleted = await personas.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Persona not found' });
    res.json({ success: true });
  });

  // AI-assisted bio generation for existing persona
  app.post('/api/personas/:id/generate-bio', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const persona = personas.get(req.params.id);
    if (!persona) return res.status(404).json({ error: 'Persona not found' });

    try {
      const provider = services.aiRouter?.selectProvider('general');
      if (!provider) return res.status(503).json({ error: 'No AI provider available. Configure an API key in Settings first.' });
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a publishing industry expert who creates compelling author bios.',
        messages: [{
          role: 'user' as const,
          content: `Write a professional author bio for a pen name "${persona.penName}" who writes ${persona.genre}${persona.subGenre ? ' (' + persona.subGenre + ')' : ''}. Style: ${persona.voiceDescription || 'engaging and professional'}. Style markers: ${persona.styleMarkers.join(', ') || 'none specified'}. Write in third person, 2-3 sentences, suitable for the back of a book. Return ONLY the bio text.`,
        }],
        maxTokens: 300,
      });
      if (result.text) {
        await personas.update(persona.id, { bio: result.text.trim() });
        res.json({ bio: result.text.trim() });
      } else {
        res.status(500).json({ error: 'AI returned empty response' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate bio: ' + String(err) });
    }
  });

}
