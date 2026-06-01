/**
 * Shared utilities for the split route mounters.
 *
 * safePath, the multer upload instance, the Wave-3 disclaimer header, and a
 * baseDir-factory for gatherChapters — all hoisted out of routes.ts so the
 * per-feature mounters can share them (one-way dep: routes.ts -> mounters).
 */
import path from 'path';
import multer from 'multer';
import type { Response } from 'express';

/** Verify resolved path stays within the allowed base directory. */
export function safePath(base: string, userInput: string): string | null {
  const resolved = path.resolve(base, userInput);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  return resolved;
}

/** Shared multer instance: 50MB limit, .txt/.md/.docx only, in-memory storage. */
export const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max (up from 10MB for novel uploads)
  fileFilter: (_req, file, cb) => {
    const allowed = ['.txt', '.md', '.docx'];
    const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${ext}" not supported. Use .txt, .md, or .docx`));
    }
  },
  storage: multer.memoryStorage(),
});

/** Sets the Wave-3 advisory header on a response. */
export function addWaveDisclaimer(res: Response): void {
  res.setHeader('X-BookClaw-Disclaimer', 'Wave 3 actions create confirmation requests but do not execute irreversible actions autonomously. You are responsible for every approved action. See SECURITY.md.');
}

/** Build a gatherChapters(project) closed over baseDir (call sites stay unchanged). */
export function makeGatherChapters(baseDir: string) {
  return async function gatherChapters(project: any): Promise<Array<{ id: string; number: number; title: string; text: string }>> {
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    const writingSteps = project.steps
      .filter((s: any) => (s.phase === 'writing' || s.label?.toLowerCase().includes('chapter')) && s.status === 'completed')
      .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

    const chapters: Array<{ id: string; number: number; title: string; text: string }> = [];
    for (const ws of writingSteps) {
      let text = ws.result || '';
      // If no inline result, try reading from disk.
      if (!text && ex(projectDir)) {
        const expectedFile = `${ws.id}-${ws.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
        const fullPath = j(projectDir, expectedFile);
        if (ex(fullPath)) {
          const raw = await rf(fullPath, 'utf-8');
          text = raw.replace(/^# .+\n\n/, '');
        }
      }
      if (text && text.length > 200) {
        chapters.push({
          id: ws.id,
          number: ws.chapterNumber || chapters.length + 1,
          title: ws.label,
          text,
        });
      }
    }
    return chapters;
  };
}
