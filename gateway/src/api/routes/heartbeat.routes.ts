import { Application, Request, Response } from 'express';
import { safePath } from './_shared.js';
import path from 'path';
import { generateDocxBuffer } from '../../services/docx-export.js';

/** Autonomous heartbeat mode, idle-task queue + history, agent journal, Author OS status, native Markdown→Word/HTML/TXT export, and tool ingestion. */
export function mountHeartbeat(app: Application, gateway: any, baseDir: string): void {
  const services = gateway.getServices();

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

  // ── Author OS tools status ──
  app.get('/api/author-os/status', (_req: Request, res: Response) => {
    if (!services.authorOS) {
      return res.json({ tools: [] });
    }
    res.json({ tools: services.authorOS.getStatus() });
  });

  // ── Native Export: Markdown → Word/HTML (no external tools needed) ──
  app.post('/api/author-os/format', async (req: Request, res: Response) => {
    const { inputFile, title, author, formats, outputDir } = req.body;
    if (!inputFile) {
      return res.status(400).json({ error: 'inputFile required' });
    }

    const { join: j, resolve: r, basename: bn } = await import('path');
    const { existsSync: ex } = await import('fs');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');

    const workspaceDir = j(baseDir, 'workspace');

    // Search for the file in workspace → projects → baseDir
    const searchPaths = [
      r(workspaceDir, inputFile),
      r(workspaceDir, 'projects', inputFile),
      r(baseDir, inputFile),
    ];
    // Also search recursively in workspace/projects/*/
    try {
      const { readdirSync } = await import('fs');
      const projectsDir = j(workspaceDir, 'projects');
      if (ex(projectsDir)) {
        for (const sub of readdirSync(projectsDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            searchPaths.push(r(projectsDir, sub.name, inputFile));
          }
        }
      }
    } catch { /* ok */ }

    let resolvedInput = '';
    for (const candidate of searchPaths) {
      if (ex(candidate)) { resolvedInput = candidate; break; }
    }

    if (!resolvedInput) {
      return res.status(404).json({ error: 'Input file not found: ' + inputFile + '. Use /files to see available files.' });
    }

    // Security: must be within project
    const resolvedBase = r(baseDir);
    if (!resolvedInput.startsWith(resolvedBase + path.sep) && resolvedInput !== resolvedBase) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    // Security: outputDir must stay within workspace
    const exportDir = safePath(workspaceDir, outputDir || 'exports');
    if (!exportDir) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    await mkd(exportDir, { recursive: true });

    const content = await rf(resolvedInput, 'utf-8');
    const docTitle = title || bn(resolvedInput, '.md');
    const docAuthor = author || 'BookClaw';
    const requestedFormats = formats || ['docx'];
    const results: string[] = [];

    try {
      // ── Word Export (native, using shared docx utility) ──
      if (requestedFormats.includes('docx') || requestedFormats.includes('all')) {
        const buffer = await generateDocxBuffer({ title: docTitle, author: docAuthor, content });
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.docx');
        await wf(outPath, buffer);
        results.push(outPath);
      }

      // ── HTML Export (native) ──
      if (requestedFormats.includes('html') || requestedFormats.includes('all')) {
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle}</title>`;
        html += `<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333;}h1{text-align:center;border-bottom:2px solid #333;padding-bottom:10px;}h2{margin-top:2em;border-bottom:1px solid #ccc;}</style></head><body>`;
        html += `<h1>${docTitle}</h1><p style="text-align:center;"><em>by ${docAuthor}</em></p><hr>`;
        // Basic markdown → HTML
        const htmlContent = content
          .replace(/^### (.*$)/gm, '<h3>$1</h3>')
          .replace(/^## (.*$)/gm, '<h2>$1</h2>')
          .replace(/^# (.*$)/gm, '<h1>$1</h1>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/\n/g, '<br>');
        html += `<p>${htmlContent}</p></body></html>`;
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.html');
        await wf(outPath, html);
        results.push(outPath);
      }

      // ── Plain Text Export ──
      if (requestedFormats.includes('txt') || requestedFormats.includes('all')) {
        const plain = content.replace(/^#{1,3}\s/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.txt');
        await wf(outPath, `${docTitle}\nby ${docAuthor}\n\n${plain}`);
        results.push(outPath);
      }

      res.json({ success: true, files: results, message: `Exported ${results.length} file(s) to ${exportDir}` });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Export failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: AI reads code, generates SKILL.md ──
  app.post('/api/tools/ingest', async (req: Request, res: Response) => {
    const { code, toolName, filePath, category } = req.body;

    if (!code && !filePath) {
      return res.status(400).json({ error: 'Provide "code" (source string) or "filePath" (relative to Author OS)' });
    }

    let sourceCode = code;

    if (filePath && !code) {
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { resolve: r } = await import('path');

      const authorOSPath = services.authorOS?.getBasePath?.();
      if (!authorOSPath) {
        return res.status(400).json({ error: 'Author OS not mounted. Provide code directly.' });
      }

      const resolvedPath = safePath(authorOSPath, filePath);
      if (!resolvedPath) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }
      if (!ex(resolvedPath)) {
        return res.status(404).json({ error: `File not found: ${filePath}` });
      }

      sourceCode = await rf(resolvedPath, 'utf-8');
    }

    const targetCategory = category || 'author';
    const ingestPrompt = `You are analyzing source code to create an BookClaw SKILL.md file.

Tool name hint: ${toolName || '(infer from code)'}
Target category: ${targetCategory}

Analyze the following source code and generate a complete SKILL.md file with:
1. YAML frontmatter (name, description, triggers, permissions)
2. Detailed usage instructions
3. Input/output documentation
4. Example commands or workflows
5. How BookClaw should invoke or reference the tool

Return ONLY the complete SKILL.md content (starting with ---).

Source code:
\`\`\`
${sourceCode.substring(0, 15000)}
\`\`\``;

    try {
      const provider = services.aiRouter.selectProvider('general');
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a technical documentation expert. Generate BookClaw SKILL.md files from source code analysis.',
        messages: [{ role: 'user', content: ingestPrompt }],
        maxTokens: 4096,
        temperature: 0.3,
      });

      res.json({
        skillMd: result.text,
        suggestedPath: `skills/${targetCategory}/${(toolName || 'unknown-tool').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/SKILL.md`,
        provider: result.provider,
        tokens: result.tokensUsed,
      });
    } catch (error) {
      res.status(500).json({ error: 'AI analysis failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: Save generated SKILL.md ──
  app.post('/api/tools/ingest/save', async (req: Request, res: Response) => {
    const { skillMd, skillPath } = req.body;
    if (!skillMd || !skillPath) {
      return res.status(400).json({ error: 'skillMd and skillPath required' });
    }

    const { join: j, resolve: r } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');

    const skillsBase = j(baseDir, 'skills');
    const fullPath = safePath(skillsBase, skillPath.replace(/^skills[/\\]?/, ''));
    if (!fullPath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    try {
      await mkdir(j(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, skillMd, 'utf-8');

      await services.skills.loadAll();

      res.json({
        success: true,
        path: skillPath,
        totalSkills: services.skills.getLoadedCount(),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save skill: ' + String(error) });
    }
  });

}
