/**
 * backup routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerBackupRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ── Backup & Restore ──

  app.post('/api/backup/create', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { mkdir: mkd, stat: st, readdir: rd, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex, cpSync } = await import('fs');

    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const backupId = `backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const backupsDir = j(baseDir, 'workspace', 'backups');
      const backupDir = j(backupsDir, backupId);
      await mkd(backupDir, { recursive: true });

      // Sources to back up: [sourceRelative, destSubfolder]
      const sources: Array<[string, string]> = [
        [j('workspace', 'projects'), 'projects'],
        [j('workspace', 'personas'), 'personas'],
        [j('workspace', 'memory'), 'memory'],
        [j('config', 'user.json'), 'config/user.json'],
        [j('workspace', 'vault.enc'), 'vault.enc'],
      ];

      for (const [srcRel, destRel] of sources) {
        const src = j(baseDir, srcRel);
        const dest = j(backupDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          // Ensure parent directory exists for file copies
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      // Write backup metadata
      await wf(j(backupDir, 'backup-meta.json'), JSON.stringify({
        id: backupId,
        createdAt: now.toISOString(),
      }, null, 2));

      // Calculate total size
      let totalSize = 0;
      async function calcSize(dir: string): Promise<void> {
        if (!ex(dir)) return;
        const entries = await rd(dir, { recursive: true });
        for (const entry of entries) {
          try {
            const fp = j(dir, String(entry));
            const s = await st(fp);
            if (s.isFile()) totalSize += s.size;
          } catch { /* skip */ }
        }
      }
      await calcSize(backupDir);

      res.json({
        success: true,
        backupId,
        path: backupDir,
        sizeKB: Math.round(totalSize / 1024),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Backup creation failed' });
    }
  });

  app.get('/api/backup/list', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    try {
      const backupsDir = j(baseDir, 'workspace', 'backups');
      if (!ex(backupsDir)) return res.json({ backups: [] });

      const entries = await rd(backupsDir);
      const backups: Array<{ id: string; createdAt: string; sizeKB: number }> = [];

      for (const entry of entries) {
        const entryPath = j(backupsDir, entry);
        const entryStat = await st(entryPath).catch(() => null);
        if (!entryStat || !entryStat.isDirectory()) continue;

        // Read metadata if available
        let createdAt = entryStat.birthtime.toISOString();
        const metaPath = j(entryPath, 'backup-meta.json');
        if (ex(metaPath)) {
          try {
            const meta = JSON.parse(await rf(metaPath, 'utf-8'));
            if (meta.createdAt) createdAt = meta.createdAt;
          } catch { /* ok */ }
        }

        // Calculate size
        let totalSize = 0;
        try {
          const files = await rd(entryPath, { recursive: true });
          for (const f of files) {
            try {
              const fp = j(entryPath, String(f));
              const s = await st(fp);
              if (s.isFile()) totalSize += s.size;
            } catch { /* skip */ }
          }
        } catch { /* ok */ }

        backups.push({ id: entry, createdAt, sizeKB: Math.round(totalSize / 1024) });
      }

      // Sort newest first
      backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json({ backups });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list backups' });
    }
  });

  app.post('/api/backup/restore/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { mkdir: mkd, stat: st, readdir: rd, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex, cpSync } = await import('fs');

    try {
      const backupId = String(req.params.id);
      const backupsDir = j(baseDir, 'workspace', 'backups');
      const backupDir = j(backupsDir, backupId);

      if (!ex(backupDir)) {
        return res.status(404).json({ error: `Backup '${backupId}' not found` });
      }

      // Create a safety backup first
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const safetyId = `pre-restore-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safetyDir = j(backupsDir, safetyId);
      await mkd(safetyDir, { recursive: true });

      // Back up current state before restoring
      const currentSources: Array<[string, string]> = [
        [j('workspace', 'projects'), 'projects'],
        [j('workspace', 'personas'), 'personas'],
        [j('workspace', 'memory'), 'memory'],
        [j('config', 'user.json'), 'config/user.json'],
        [j('workspace', 'vault.enc'), 'vault.enc'],
      ];

      for (const [srcRel, destRel] of currentSources) {
        const src = j(baseDir, srcRel);
        const dest = j(safetyDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      await wf(j(safetyDir, 'backup-meta.json'), JSON.stringify({
        id: safetyId,
        createdAt: now.toISOString(),
        reason: `Pre-restore safety backup before restoring ${backupId}`,
      }, null, 2));

      // Restore from the selected backup
      const restoreMap: Array<[string, string]> = [
        ['projects', j('workspace', 'projects')],
        ['personas', j('workspace', 'personas')],
        ['memory', j('workspace', 'memory')],
        ['config/user.json', j('config', 'user.json')],
        ['vault.enc', j('workspace', 'vault.enc')],
      ];

      for (const [srcRel, destRel] of restoreMap) {
        const src = j(backupDir, srcRel);
        const dest = j(baseDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      res.json({
        success: true,
        restoredFrom: backupId,
        safetyBackup: safetyId,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Restore failed' });
    }
  });

  app.delete('/api/backup/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { rm } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    try {
      const backupId = String(req.params.id);
      const backupDir = j(baseDir, 'workspace', 'backups', backupId);

      if (!ex(backupDir)) {
        return res.status(404).json({ error: `Backup '${backupId}' not found` });
      }

      await rm(backupDir, { recursive: true });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Delete failed' });
    }
  });

}
