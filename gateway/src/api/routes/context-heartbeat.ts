/**
 * context-heartbeat routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { safePath } from '../context.js';

export function registerContextHeartbeatRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Context Engine & Continuity Checker
  // ═══════════════════════════════════════════════════════════

  // Get project context (summaries + entities)
  app.get('/api/projects/:id/context', async (req: Request, res: Response) => {
    try {
      const engine = gateway.getProjectEngine?.();
      if (!engine) return res.status(503).json({ error: 'Not initialized' });
      const project = engine.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.json({ summaries: [], entities: [] });

      const ctx = await contextEngine.loadContext(req.params.id);
      res.json({ summaries: ctx.summaries, entities: ctx.entities });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Run continuity check (async — responds immediately, emits progress via socket)
  app.post('/api/projects/:id/continuity-check', async (req: Request, res: Response) => {
    try {
      const engine = gateway.getProjectEngine?.();
      if (!engine) return res.status(503).json({ error: 'Not initialized' });
      const project = engine.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.status(503).json({ error: 'Context engine not available' });

      const aiCompleteFn = (request: any) => services.aiRouter.complete(request);
      const aiSelectFn = (taskType: string) => services.aiRouter.selectProvider(taskType);

      // Run asynchronously, respond immediately
      res.json({ status: 'started', projectId: req.params.id });

      contextEngine.runContinuityCheck(
        req.params.id,
        aiCompleteFn,
        aiSelectFn,
        (msg: string) => {
          // Emit progress via socket if available
          try { (gateway as any).io?.emit?.('continuity-progress', { projectId: req.params.id, message: msg }); } catch {}
        }
      ).then((report: any) => {
        try { (gateway as any).io?.emit?.('continuity-complete', { projectId: req.params.id, report }); } catch {}
      }).catch((err: any) => {
        try { (gateway as any).io?.emit?.('continuity-error', { projectId: req.params.id, error: err.message }); } catch {}
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get stored continuity report
  app.get('/api/projects/:id/continuity-report', async (req: Request, res: Response) => {
    try {
      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.json({ report: null });

      const report = contextEngine.getReport(req.params.id);
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Autonomous Heartbeat Mode
  // ═══════════════════════════════════════════════════════════

  // Get autonomous mode status
  app.get('/api/autonomous/status', (_req: Request, res: Response) => {
    res.json(services.heartbeat.getAutonomousStatus());
  });

  // Enable autonomous mode
  app.post('/api/autonomous/enable', (_req: Request, res: Response) => {
    services.heartbeat.enableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Disable autonomous mode
  app.post('/api/autonomous/disable', (_req: Request, res: Response) => {
    services.heartbeat.disableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Pause autonomous mode
  app.post('/api/autonomous/pause', (_req: Request, res: Response) => {
    services.heartbeat.pauseAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Resume autonomous mode
  app.post('/api/autonomous/resume', (_req: Request, res: Response) => {
    services.heartbeat.resumeAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Update autonomous config (interval, max steps, quiet hours)
  app.post('/api/autonomous/config', (req: Request, res: Response) => {
    const { intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd } = req.body;
    services.heartbeat.updateAutonomousConfig({
      intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd,
    });
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // ── Idle Task Queue (CRUD) + History ──

  // Get task queue (user-configurable) + completed task history
  app.get('/api/autonomous/idle-tasks', async (_req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readdir, readFile, stat, writeFile, mkdir } = await import('fs/promises');
      const { existsSync } = await import('fs');

      // Load task queue from config
      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      let queue: any[] = [];
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf-8');
        queue = JSON.parse(raw).tasks || [];
      } else {
        // Initialize with defaults
        const { DEFAULT_IDLE_TASKS } = await import('../../services/idle-tasks-defaults.js');
        queue = DEFAULT_IDLE_TASKS;
        const configDir = j(baseDir, 'workspace', '.config');
        await mkdir(configDir, { recursive: true });
        await writeFile(configPath, JSON.stringify({ tasks: queue }, null, 2), 'utf-8');
      }

      // Load completed task history from .agent directory
      const agentDir = j(baseDir, 'workspace', '.agent');
      const history: any[] = [];
      if (existsSync(agentDir)) {
        const files = await readdir(agentDir);
        const idleFiles = files.filter(f => f.startsWith('idle-') && f.endsWith('.md')).sort().reverse();
        for (const file of idleFiles.slice(0, 20)) {
          const content = await readFile(j(agentDir, file), 'utf-8');
          const fileStat = await stat(j(agentDir, file));
          const titleMatch = content.match(/^# (.+)$/m);
          history.push({
            file,
            title: titleMatch ? titleMatch[1] : file,
            preview: content.substring(0, 300),
            date: fileStat.mtime.toISOString(),
            size: fileStat.size,
          });
        }
      }

      res.json({ queue, history });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load idle tasks: ' + String(err) });
    }
  });

  // Save entire task queue (replace all)
  app.put('/api/autonomous/idle-tasks', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { writeFile, mkdir } = await import('fs/promises');
      const { tasks } = req.body;
      if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
      const configDir = j(baseDir, 'workspace', '.config');
      await mkdir(configDir, { recursive: true });
      await writeFile(j(configDir, 'idle-tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.json({ success: true, count: tasks.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save idle tasks: ' + String(err) });
    }
  });

  // Add a single task
  app.post('/api/autonomous/idle-tasks', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const { label, prompt, enabled } = req.body;
      if (!label || !prompt) return res.status(400).json({ error: 'label and prompt are required' });

      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      let tasks: any[] = [];
      if (existsSync(configPath)) {
        tasks = JSON.parse(await readFile(configPath, 'utf-8')).tasks || [];
      }
      tasks.push({ label, prompt, enabled: enabled !== false });
      const configDir = j(baseDir, 'workspace', '.config');
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.status(201).json({ success: true, task: tasks[tasks.length - 1], index: tasks.length - 1 });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add idle task: ' + String(err) });
    }
  });

  // Delete a task by index
  app.delete('/api/autonomous/idle-tasks/:index', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readFile, writeFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const idx = parseInt(String(req.params.index));
      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      if (!existsSync(configPath)) return res.status(404).json({ error: 'No idle tasks configured' });

      const tasks: any[] = JSON.parse(await readFile(configPath, 'utf-8')).tasks || [];
      if (idx < 0 || idx >= tasks.length) return res.status(404).json({ error: 'Task index out of range' });
      const removed = tasks.splice(idx, 1);
      await writeFile(configPath, JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.json({ success: true, removed: removed[0], remaining: tasks.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete idle task: ' + String(err) });
    }
  });

  // Download completed idle task file
  app.get('/api/autonomous/idle-tasks/history/:filename', async (req: Request, res: Response) => {
    try {
      const { join: j, resolve: r } = await import('path');
      const { readFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const agentDir = j(baseDir, 'workspace', '.agent');
      const filePath = safePath(agentDir, String(req.params.filename));
      if (!filePath) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: 'Idle task file not found' });
      }
      const content = await readFile(filePath, 'utf-8');
      res.json({ content, filename: req.params.filename });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read idle task: ' + String(err) });
    }
  });

  // ── Agent Journal ──
  app.get('/api/agent/journal', (_req: Request, res: Response) => {
    res.json({ journal: services.heartbeat.getJournal() });
  });

  app.get('/api/agent/status', (_req: Request, res: Response) => {
    const autonomousStatus = services.heartbeat.getAutonomousStatus();
    const stats = services.heartbeat.getStats();
    res.json({
      ...autonomousStatus,
      todayWords: stats.todayWords,
      dailyWordGoal: stats.dailyWordGoal,
      streak: stats.streak,
      goalPercent: stats.goalPercent,
    });
  });

}
