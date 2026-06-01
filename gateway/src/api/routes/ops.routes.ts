import { Application, Request, Response } from 'express';

/** Lessons API, Preferences API, and Orchestrator (script manager) API. */
export function mountOps(app: Application, gateway: any, baseDir: string): void {
  const services = gateway.getServices();

  // ═══════════════════════════════════════════════════════════
  // Lessons API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lessons', (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.json({ lessons: [] });
    res.json({ lessons: lessons.getAll() });
  });

  app.post('/api/lessons', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const { category, lesson: text, source, confidence, goalId } = req.body;
    if (!text) return res.status(400).json({ error: 'lesson text required' });

    const result = await lessons.addLesson({
      timestamp: new Date().toISOString(),
      category: category || 'general',
      lesson: text,
      source: source || 'user-feedback',
      confidence: confidence ?? 0.7,
      goalId,
    });
    res.json({ lesson: result });
  });

  app.post('/api/lessons/:id/adjust', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const delta = req.body.delta ?? 0;
    const result = await lessons.adjustConfidence(req.params.id, delta);
    if (!result) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ lesson: result });
  });

  app.delete('/api/lessons', async (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });
    await lessons.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Preferences API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/preferences', (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.json({ preferences: {}, metadata: {} });
    res.json(prefs.getAllWithMetadata());
  });

  app.post('/api/preferences', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const { key, value, source } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });

    await prefs.set(key, value, source || 'explicit');
    res.json({ success: true, preferences: prefs.getAll() });
  });

  app.delete('/api/preferences/:key', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const removed = await prefs.remove(req.params.key);
    if (!removed) return res.status(404).json({ error: 'Preference not found' });
    res.json({ success: true });
  });

  app.delete('/api/preferences', async (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });
    await prefs.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Orchestrator API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/orchestrator/status', (_req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ scripts: [] });
    res.json({ scripts: orch.getStatus() });
  });

  app.get('/api/orchestrator/scripts', (_req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ configs: [] });
    res.json({ configs: orch.getConfigs() });
  });

  app.post('/api/orchestrator/scripts', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const { id, name, command, args, cwd, autoStart, autoRestart, tags } = req.body;
    if (!id || !name || !command) {
      return res.status(400).json({ error: 'id, name, and command required' });
    }

    try {
      const config = await orch.addScript({ id, name, command, args, cwd, autoStart, autoRestart, tags });
      res.json({ config });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/orchestrator/scripts/:id/start', (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = orch.startScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.post('/api/orchestrator/scripts/:id/stop', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = await orch.stopScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.post('/api/orchestrator/scripts/:id/restart', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = await orch.restartScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.get('/api/orchestrator/scripts/:id/logs', (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ logs: [] });

    const count = parseInt(String(req.query.count)) || 50;
    const logs = orch.getLogs(req.params.id, count);
    res.json({ logs });
  });

  app.delete('/api/orchestrator/scripts/:id', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const removed = await orch.removeScript(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Script not found' });
    res.json({ success: true });
  });

}
