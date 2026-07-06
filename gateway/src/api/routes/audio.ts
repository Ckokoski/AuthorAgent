/**
 * audio routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import { safePath } from '../context.js';

export function registerAudioRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // TTS / Audio (Edge TTS free + ElevenLabs paid — pluggable providers)
  // ═══════════════════════════════════════════════════════════

  /**
   * Resolve voice priority: explicit voice > persona's voice > project preset > default.
   * Used by both /api/audio/generate and the project narration code.
   */
  async function resolveVoiceForRequest(opts: {
    explicitVoice?: string;
    personaId?: string;
    projectId?: string;
  }): Promise<{ voice?: string; provider?: 'edge' | 'elevenlabs' }> {
    if (opts.explicitVoice) return { voice: opts.explicitVoice };
    // Try project's linked persona
    if (opts.projectId && services.projects) {
      const project = services.projects.getProject?.(opts.projectId);
      if (project?.personaId && services.personas) {
        const persona = services.personas.get?.(project.personaId);
        if (persona?.ttsVoice) return { voice: persona.ttsVoice };
      }
    }
    // Or direct personaId
    if (opts.personaId && services.personas) {
      const persona = services.personas.get?.(opts.personaId);
      if (persona?.ttsVoice) return { voice: persona.ttsVoice };
    }
    return {};
  }

  // Generate audio from text. Provider auto-detected from voice format
  // (Edge for "en-US-AriaNeural"-style, ElevenLabs for 20-char voice_ids).
  app.post('/api/audio/generate', async (req: Request, res: Response) => {
    const { text, voice, rate, pitch, volume, provider, personaId, projectId, elevenLabsModel } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text required' });
    }
    if (text.length > 50000) {
      return res.status(400).json({ error: 'Text too long (max 50,000 chars)' });
    }

    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }

    // Resolve persona-aware voice if no explicit voice was passed.
    const resolved = await resolveVoiceForRequest({
      explicitVoice: voice,
      personaId,
      projectId,
    });

    const result = await services.tts.generate(text, {
      voice: resolved.voice,
      provider: provider || resolved.provider,
      rate, pitch, volume,
      elevenLabsModel,
    });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  // List available voices from all configured providers.
  // Returns Edge presets always; adds ElevenLabs voices when an API key is configured.
  app.get('/api/audio/voices', async (_req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    const presets = services.tts.listPresets();
    let elevenLabs: any[] = [];
    try {
      elevenLabs = await services.tts.listElevenLabsVoices();
    } catch { /* non-fatal — feature is optional */ }
    res.json({
      activeProvider: services.tts.getActiveProvider(),
      activeVoice: services.tts.getActiveVoice(),
      presets,
      elevenLabs,
    });
  });

  // Set the global default TTS provider/voice.
  app.post('/api/audio/config', async (req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    const { voice, provider } = req.body || {};
    if (voice) await services.tts.setVoice(voice);
    if (provider === 'edge' || provider === 'elevenlabs') {
      await services.tts.setProvider(provider);
    }
    res.json({
      activeProvider: services.tts.getActiveProvider(),
      activeVoice: services.tts.getActiveVoice(),
    });
  });

  // Serve generated audio files
  app.get('/api/audio/file/:filename', async (req: Request, res: Response) => {
    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const audioDir = path.join(baseDir, 'workspace', 'audio');
    const filePath = safePath(audioDir, fname);

    // Security: prevent path traversal
    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const ext = fname.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
    };
    res.setHeader('Content-Type', mimeTypes[ext || ''] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // List available voice presets
  app.get('/api/audio/voices', async (_req: Request, res: Response) => {
    const { TTSService } = await import('../../services/tts.js');
    const activeVoice = services.tts?.getActiveVoice() || 'en-US-AriaNeural';
    res.json({
      available: true,
      activeVoice,
      presets: TTSService.VOICE_PRESETS,
    });
  });

  // Get/set the active voice
  app.get('/api/audio/voice', async (_req: Request, res: Response) => {
    res.json({ voice: services.tts?.getActiveVoice() || 'en-US-AriaNeural' });
  });

  app.post('/api/audio/voice', async (req: Request, res: Response) => {
    const { voice } = req.body;
    if (!voice || typeof voice !== 'string') {
      return res.status(400).json({ error: 'voice is required (e.g., "narrator_female" or "en-US-AriaNeural")' });
    }
    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }
    // Resolve preset name to voice ID before saving
    const resolvedVoice = services.tts.resolveVoice(voice);
    await services.tts.setVoice(resolvedVoice);
    res.json({ success: true, voice: resolvedVoice, message: `Voice set to ${resolvedVoice}. This persists across restarts.` });
  });

}
