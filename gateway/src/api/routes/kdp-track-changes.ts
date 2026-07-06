/**
 * kdp-track-changes routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import { upload } from '../context.js';

export function registerKdpTrackChangesRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // KDP Blurb Export
  // ═══════════════════════════════════════════════════════════

  // Export an arbitrary blurb (doesn't require a project)
  app.post('/api/kdp/export-blurb', (req: Request, res: Response) => {
    const exporter = services.kdpExporter;
    if (!exporter) return res.status(503).json({ error: 'KDP exporter not initialized' });
    const { blurb } = req.body || {};
    if (!blurb || typeof blurb !== 'string') {
      return res.status(400).json({ error: 'blurb (string) required' });
    }
    try {
      const result = exporter.exportBlurb(blurb);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Export failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Track Changes — DOCX editor roundtrip
  // ═══════════════════════════════════════════════════════════

  // Upload an edited .docx; return the structured diff report.
  app.post('/api/track-changes/parse', upload.single('file'), async (req: Request, res: Response) => {
    const tc = services.trackChanges;
    if (!tc) return res.status(503).json({ error: 'Track-changes service not initialized' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = '.' + (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (ext !== '.docx') {
      return res.status(400).json({ error: 'Only .docx files are supported for track-changes parsing' });
    }

    try {
      const report = tc.parseDocx(req.file.buffer);
      // Cache the file on disk so the apply-decisions endpoint can reuse it.
      const { mkdir: mkd, writeFile: wf } = await import('fs/promises');
      const cacheDir = path.join(baseDir, 'workspace', 'tmp', 'track-changes');
      await mkd(cacheDir, { recursive: true });
      // Sanitize filename to prevent traversal.
      const safeName = req.file.originalname
        .replace(/[\x00-\x1f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.\.+/g, '_')
        .slice(0, 200);
      const cacheKey = `${Date.now()}-${safeName}`;
      await wf(path.join(cacheDir, cacheKey), req.file.buffer);
      res.json({ cacheKey, report });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Parse failed' });
    }
  });

  // Apply accept/reject decisions to produce clean Markdown.
  app.post('/api/track-changes/apply', async (req: Request, res: Response) => {
    const tc = services.trackChanges;
    if (!tc) return res.status(503).json({ error: 'Track-changes service not initialized' });

    const { cacheKey, decisions } = req.body || {};
    if (!cacheKey || !decisions || typeof decisions !== 'object') {
      return res.status(400).json({ error: 'cacheKey (from /parse) and decisions ({ [changeId]: "accepted"|"rejected" }) required' });
    }

    // Validate cacheKey — must match the expected format and stay inside the tmp dir.
    if (!/^[\d]+-[^\\/]+$/.test(cacheKey)) {
      return res.status(400).json({ error: 'Invalid cacheKey' });
    }

    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const cachePath = path.join(baseDir, 'workspace', 'tmp', 'track-changes', cacheKey);
    if (!ex(cachePath)) return res.status(404).json({ error: 'Cached upload not found. Re-upload and try again.' });

    try {
      const buffer = await rf(cachePath);
      const decisionMap = new Map<string, 'accepted' | 'rejected' | 'pending'>();
      for (const [id, status] of Object.entries(decisions)) {
        if (status === 'accepted' || status === 'rejected' || status === 'pending') {
          decisionMap.set(id, status);
        }
      }
      const markdown = tc.applyDecisions(buffer, decisionMap);
      res.json({ markdown, charCount: markdown.length, wordCount: markdown.split(/\s+/).filter(Boolean).length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Apply failed' });
    }
  });

}
