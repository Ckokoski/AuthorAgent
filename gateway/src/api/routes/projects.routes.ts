import { Application, Request, Response } from 'express';
import { generateDocxBuffer } from '../../services/docx-export.js';

/**
 * Project Engine endpoints: templates, project + pipeline creation, start/
 * auto-execute (with the step-message + manuscript helpers), retry/restart/
 * resume/pause, files listing/download, DOCX export, compile, provider override.
 */
export function mountProjects(app: Application, gateway: any, baseDir: string): void {
  const services = gateway.getServices();

  // ═══════════════════════════════════════════════════════════
  // Project Engine (autonomous project-based task planning)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/templates', async (_req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    // Merge built-in templates with custom templates
    const builtIn = engine.getTemplates();
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    const customMapped = custom.map((t: any) => ({
      ...t, label: t.title, stepCount: 0, custom: true,
    }));
    res.json({ templates: [...builtIn, ...customMapped] });
  });

  // Save a custom project template
  app.post('/api/projects/templates', async (req: Request, res: Response) => {
    const { title, description, type } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { randomBytes } = await import('crypto');
    const configDir = j(baseDir, 'workspace', '.config');
    await mkd(configDir, { recursive: true });
    const customPath = j(configDir, 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    custom.push({ id: randomBytes(6).toString('hex'), title, description, type: type || 'general', createdAt: new Date().toISOString() });
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Delete a custom project template
  app.delete('/api/projects/templates/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-project-templates.json');
    if (!ex(customPath)) {
      return res.json({ success: false, error: 'No custom templates' });
    }
    let custom: any[] = [];
    try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    custom = custom.filter((t: any) => t.id !== req.params.id);
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Create a new project — supports dynamic AI planning
  app.post('/api/projects/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { type, title, description, context, planning, config, personaId, preferredProvider } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }

    // Helper to set optional fields on newly created projects
    const applyProjectOptions = (project: any) => {
      if (personaId) project.personaId = personaId;
      if (preferredProvider) project.preferredProvider = preferredProvider;
    };

    // ── Chapter-count + words-per-chapter field aliasing ──
    // Bug fix (2026-04): the dashboard sends `chapters` and `wordsPerChapter`
    // at the top level, but createBookProduction / createNovelPipeline expect
    // `config.targetChapters` and `config.targetWordsPerChapter`. Without this
    // translation, projects silently default to 25 chapters / 3000 words
    // regardless of what the user typed in the modal.
    const resolvedConfig: any = { ...(config || context || {}) };
    if (req.body.chapters !== undefined && resolvedConfig.targetChapters === undefined) {
      const n = Number(req.body.chapters);
      if (Number.isFinite(n) && n > 0) resolvedConfig.targetChapters = n;
    }
    if (req.body.wordsPerChapter !== undefined && resolvedConfig.targetWordsPerChapter === undefined) {
      const n = Number(req.body.wordsPerChapter);
      if (Number.isFinite(n) && n > 0) resolvedConfig.targetWordsPerChapter = n;
    }

    // Novel pipeline: use dedicated pipeline builder
    // Trust the explicitly-sent type; only infer from description if no type provided
    const inferredType = type || engine.inferProjectType(description);
    if (inferredType === 'novel-pipeline') {
      const project = engine.createNovelPipeline(title, description, resolvedConfig);
      applyProjectOptions(project);
      return res.json({ project, planning: 'novel-pipeline' });
    }

    // Book Production: uses dynamic chapter generation
    if (inferredType === 'book-production') {
      const project = engine.createBookProduction(title, description, resolvedConfig);
      applyProjectOptions(project);
      return res.json({ project, planning: 'book-production' });
    }

    // Dynamic planning: ask the AI to figure out the steps
    if (planning === 'dynamic') {
      const skillCatalog = services.skills.getSkillCatalog();
      const authorOSTools = services.authorOS?.getAvailableTools() || [];
      const project = await engine.planProject(title, description, skillCatalog, authorOSTools, context);
      applyProjectOptions(project);
      return res.json({ project, planning: 'dynamic' });
    }

    // Template-based fallback
    const projectType = inferredType;
    const project = engine.createProject(projectType, title, description, context);
    applyProjectOptions(project);
    res.json({ project, planning: 'template' });
  });

  // ── Pipeline Creation (chains all 6 phases) ──
  app.post('/api/pipeline/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { title, description, personaId, config } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    try {
      const result = engine.createPipeline(title, description, personaId, config);
      res.json({
        pipelineId: result.pipelineId,
        phases: result.projects.map((p: any) => ({
          id: p.id,
          type: p.type,
          title: p.title,
          phase: p.pipelinePhase,
          steps: p.steps.length,
          status: p.status,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create pipeline: ' + String(err) });
    }
  });

  // ── Pipeline Status ──
  app.get('/api/pipeline/:pipelineId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const projects = engine.getPipelineProjects(req.params.pipelineId);
    if (projects.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    res.json({
      pipelineId: req.params.pipelineId,
      phases: projects.map((p: any) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        phase: p.pipelinePhase,
        steps: p.steps.length,
        completedSteps: p.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length,
        status: p.status,
        progress: p.progress,
      })),
    });
  });

  app.get('/api/projects/list', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const status = (req.query as any).status;
    res.json({ projects: engine.listProjects(status) });
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ project });
  });

  app.post('/api/projects/:id/start', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const step = engine.startProject(req.params.id);
    if (!step) {
      return res.status(404).json({ error: 'Project not found or no pending steps' });
    }
    res.json({ step, project: engine.getProject(req.params.id) });
  });

  /**
   * Smart excerpt builder for large manuscripts.
   * Reads the full document from disk and extracts a relevant excerpt
   * that fits within AI context limits while preserving the most useful content.
   *
   * Strategy: first 20K chars + last 5K chars (with truncation marker)
   * This gives the AI the beginning (setup, style, voice) and ending (current state)
   * which is ideal for revision, editing, and analysis tasks.
   */
  async function getSmartExcerpt(filePath: string, wordCount: number, maxChars = 25000): Promise<string> {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    if (!ex(filePath)) {
      return `[Document not found at ${filePath} — it may have been moved or deleted]`;
    }

    const fullText = await rf(filePath, 'utf-8');

    if (fullText.length <= maxChars) {
      return fullText; // Small enough to include everything
    }

    // Smart split: 80% head + 20% tail
    const headSize = Math.floor(maxChars * 0.8);
    const tailSize = maxChars - headSize;
    const head = fullText.substring(0, headSize);
    const tail = fullText.substring(fullText.length - tailSize);

    const omittedChars = fullText.length - headSize - tailSize;
    const omittedWords = Math.round(omittedChars / 5); // rough estimate

    return `${head}\n\n` +
      `[... ⚠️ MIDDLE SECTION OMITTED: ~${omittedWords.toLocaleString()} words skipped to fit context. ` +
      `Full document (${wordCount.toLocaleString()} words) is saved in workspace/documents/. ...]\n\n` +
      `${tail}`;
  }

  // Returns true if the step requires the FULL manuscript in context (not a truncated excerpt).
  // Revision-apply steps must see the whole book to rewrite it correctly.
  function stepNeedsFullManuscript(step: any): boolean {
    const phase = String(step?.phase || '').toLowerCase();
    const label = String(step?.label || '').toLowerCase();
    return phase === 'revision_apply' ||
      label.includes('apply macro revision') ||
      label.includes('apply scene-level revision') ||
      label.includes('apply line-level revision') ||
      label.includes('full manuscript rewrite');
  }

  // Helper: build user message for project step execution
  // Injects uploaded manuscript DIRECTLY into the user message so the AI can't miss it
  // For large documents (15K+ words): reads from disk and applies smart truncation
  async function buildStepUserMessage(project: any, step: any): Promise<string> {
    let message = step.prompt;
    const uploads = project.context?.uploads || [];
    const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount?.toLocaleString() || '?'} words)`).join(', ');

    // Revision-apply steps need to see the full manuscript; analysis steps get a smart excerpt.
    const fullNeeded = stepNeedsFullManuscript(step);
    const charCap = fullNeeded ? 600000 : 30000;  // ~120K words when needed (fits Claude/Gemini context)

    // Large document path: read from disk with cap-aware truncation
    if (project.context?.documentLibraryFile) {
      const excerpt = await getSmartExcerpt(
        project.context.documentLibraryFile,
        project.context.documentWordCount || 0,
        charCap
      );
      const headerNote = fullNeeded
        ? `\n\n⚠️ This is a REVISION APPLY step. You MUST rewrite the ENTIRE manuscript below (or as much as fits in your response — the system will ask for continuations).\n\n`
        : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${excerpt}\n\n---\n\n## Your Task\n\n${message}`;
      return message;
    }

    // Small document path: use inline uploaded content
    if (project.context?.uploadedContent) {
      const uploaded = String(project.context.uploadedContent).substring(0, charCap);
      const headerNote = fullNeeded
        ? `\n\n⚠️ This is a REVISION APPLY step. You MUST rewrite the ENTIRE manuscript below (or as much as fits in your response — the system will ask for continuations).\n\n`
        : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${uploaded}\n\n---\n\n## Your Task\n\n${message}`;
    }

    return message;
  }

  app.post('/api/projects/:id/execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const activeStep = project.steps.find((s: any) => s.status === 'active');
    if (!activeStep) {
      return res.status(400).json({ error: 'No active step. Start the project first.' });
    }

    try {
      const projectContext = await engine.buildProjectContext(project, activeStep);
      const userMessage = await buildStepUserMessage(project, activeStep);
      let response = '';

      await gateway.handleMessage(
        userMessage,
        'projects',
        (text: string) => { response = text; },
        projectContext,
        activeStep.taskType || undefined  // Use step's own taskType for routing
      );

      // Retry once with 'general' routing if the response is too short
      if (!response || response.length < 50) {
        console.log(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
        response = '';
        await gateway.handleMessage(
          userMessage,
          'projects',
          (text: string) => { response = text; },
          projectContext,
          'general'
        );
      }

      // Detect the [AI provider failure] sentinel from handleMessage when both
      // primary and fallback errored. Treat as failure with the real reason
      // instead of writing the error message into the manuscript file.
      if (response && response.startsWith('[AI provider failure]')) {
        const detail = response.replace(/^\[AI provider failure\]\s*/, '').substring(0, 500);
        engine.failStep(project.id, activeStep.id, detail);
        return res.json({
          success: false,
          error: 'AI provider failure — see detail',
          detail,
          project: engine.getProject(project.id),
        });
      }
      if (!response || response.length < 50) {
        const reason = `AI returned an unusably short response (${response?.length ?? 0} chars). ` +
          `This usually means the chosen provider hit a safety filter, ran out of context, or the model is misconfigured. ` +
          `Try a different provider in Settings, shorten the project description, or split the task.`;
        engine.failStep(project.id, activeStep.id, reason);
        return res.json({
          success: false,
          error: reason,
          project: engine.getProject(project.id),
        });
      }

      const nextStep = engine.completeStep(project.id, activeStep.id, response);

      res.json({
        success: true,
        completedStep: activeStep.id,
        response,
        nextStep,
        project: engine.getProject(project.id),
      });
    } catch (error) {
      engine.failStep(project.id, activeStep.id, String(error));
      res.status(500).json({
        error: 'Step execution failed: ' + String(error),
        project: engine.getProject(project.id),
      });
    }
  });

  // Auto-execute ALL steps of a project (fully autonomous mode)
  // ── Retry a single step (reset failed/completed → pending) ──
  // Useful when a step failed and the user wants to retry without restarting
  // the whole project. Optionally deletes the previous output file.
  app.post('/api/projects/:id/steps/:stepId/retry', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const step = engine.retryStep(req.params.id, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    // Optionally delete the step's output file so the next run starts clean.
    if (req.body?.deleteOutputFile) {
      try {
        const { unlink } = await import('fs/promises');
        const { join: jp } = await import('path');
        const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const projectDir = jp(baseDir, 'workspace', 'projects', projectSlug);
        const filename = `${step.id}-${step.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
        await unlink(jp(projectDir, filename)).catch(() => {});
      } catch { /* non-fatal */ }
    }

    res.json({ step, project: engine.getProject(req.params.id) });
  });

  // ── Restart the whole project ──
  // Resets failed/active (and optionally completed) steps to pending so the
  // user can re-run from a clean state. Optionally deletes all output files.
  app.post('/api/projects/:id/restart', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const keepCompleted = !!req.body?.keepCompleted;
    const result = engine.restartProject(req.params.id, { keepCompleted });
    if (!result) return res.status(404).json({ error: 'Project not found' });

    if (req.body?.deleteOutputFiles) {
      try {
        const { rm } = await import('fs/promises');
        const { readdirSync, existsSync: ex } = await import('fs');
        const { join: jp } = await import('path');
        const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const projectDir = jp(baseDir, 'workspace', 'projects', projectSlug);
        if (ex(projectDir)) {
          // Only delete .md files, preserve manuscript / compiled-output / revised files
          // unless restart is full (no keepCompleted).
          const files = readdirSync(projectDir);
          for (const f of files) {
            if (!f.endsWith('.md')) continue;
            if (keepCompleted && (f === 'manuscript.md' || f === 'compiled-output.md' || f === 'revised-manuscript.md' || f === 'revision-report.md')) continue;
            await rm(jp(projectDir, f)).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }
    }

    res.json(result);
  });

  app.post('/api/projects/:id/auto-execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.status === 'pending') {
      engine.startProject(req.params.id);
    } else if (project.status === 'paused') {
      project.status = 'active';
      const firstPending = project.steps.find((s: any) => s.status === 'pending');
      if (firstPending) firstPending.status = 'active';
    }

    const results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }> = [];
    const { join } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const workspaceDir = join(baseDir, 'workspace');

    while (true) {
      const currentProject = engine.getProject(req.params.id);
      if (!currentProject) break;

      // Check if project was paused externally (via /stop or dashboard)
      if (currentProject.status === 'paused' || currentProject.status === 'completed') break;

      const activeStep = currentProject.steps.find((s: any) => s.status === 'active');
      if (!activeStep) break;

      try {
        const projectContext = await engine.buildProjectContext(currentProject, activeStep);
        const userMessage = await buildStepUserMessage(currentProject, activeStep);
        let response = '';

        await gateway.handleMessage(
          userMessage,
          'project-engine',
          (text: string) => { response = text; },
          projectContext,
          activeStep.taskType || undefined  // Use step's own taskType for routing
        );

        // Retry once with 'general' routing if the response is too short
        // This catches cases where a premium/mid provider fails but free providers work fine
        if (!response || response.length < 50) {
          console.log(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
          response = '';
          await gateway.handleMessage(
            userMessage,
            'project-engine',
            (text: string) => { response = text; },
            projectContext,
            'general'  // Force free-tier routing (Gemini first)
          );
        }

        if (response && response.startsWith('[AI provider failure]')) {
          const detail = response.replace(/^\[AI provider failure\]\s*/, '').substring(0, 500);
          engine.failStep(currentProject.id, activeStep.id, detail);
          results.push({ step: activeStep.label, success: false, error: detail });
          break;
        }
        if (!response || response.length < 50) {
          const reason = `AI returned an unusably short response (${response?.length ?? 0} chars). ` +
            `Cause is usually a safety filter trip, context overflow, or misconfigured provider. ` +
            `Switch providers in Settings or shorten the project description.`;
          engine.failStep(currentProject.id, activeStep.id, reason);
          results.push({ step: activeStep.label, success: false, error: reason });
          break;
        }

        // ── Continuation logic for long-output steps (revision-apply + novel writing) ──
        // Revision-apply steps must produce a FULL manuscript. If the response is shorter
        // than the source (or shorter than the explicit wordCountTarget), ask the AI to
        // continue. This prevents the user from getting a half-revised book.
        {
          const isRevisionApply = stepNeedsFullManuscript(activeStep);
          const wcTarget = (activeStep as any).wordCountTarget ||
            (isRevisionApply ? Math.floor((currentProject.context?.documentWordCount || 0) * 0.9) : 0);
          if (wcTarget && wcTarget > 0) {
            let wc = response.split(/\s+/).length;
            let continuations = 0;
            while (wc < wcTarget && continuations < 6) {
              continuations++;
              const remaining = wcTarget - wc;
              console.log(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Response word count: ${wc}/${wcTarget} — requesting continuation #${continuations} (~${remaining} more words)`);
              let contResponse = '';
              try {
                const contPrompt = isRevisionApply
                  ? `Continue the revised manuscript from EXACTLY where you left off. You've produced ${wc} words so far; the target is ${wcTarget}. Output at least ${Math.min(remaining, 15000)} more words of the revised manuscript, continuing from the last chapter boundary. Do NOT repeat content. Do NOT summarize. Do NOT add commentary. Output ONLY the continued manuscript prose.`
                  : `Continue writing from where you left off. You wrote ${wc} words so far but the target is ${wcTarget}. Write at least ${remaining} more words of prose narrative, continuing the story seamlessly. Do NOT repeat what was already written. Do NOT summarize.`;
                await gateway.handleMessage(
                  contPrompt,
                  'project-engine',
                  (text: string) => { contResponse = text; },
                  projectContext,
                  activeStep.taskType || undefined,
                );
                if (contResponse.length > 100) {
                  response = response + '\n\n' + contResponse;
                  wc = response.split(/\s+/).length;
                } else {
                  break;
                }
              } catch {
                break;
              }
            }
            if (continuations > 0) {
              console.log(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Final word count after ${continuations} continuation(s): ${response.split(/\s+/).length}`);
            }
          }
        }

        // ── Quality loop: evaluate + retry on write/polish steps ──
        // AutoNovel-inspired modify-evaluate-retry. Defaults to 1 retry
        // (so each chapter costs at most 3 AI calls: draft + judge + retry).
        // Authors can disable per-project via context.qualityLoopEnabled=false.
        try {
          const judge = services.writingJudge;
          const stepSkill = (activeStep as any).skill || '';
          const stepPhase = (activeStep as any).phase || '';
          const isQualityCandidate = stepSkill === 'write' || stepPhase === 'polish';
          const qualityLoopEnabled = currentProject.context?.qualityLoopEnabled !== false;
          const qualityThreshold = Number(currentProject.context?.qualityThreshold) || 70;
          const maxRetries = Number(currentProject.context?.qualityMaxRetries) ?? 1;
          // Per-project flag for the dual Craft + Market judge mode.
          // Doubles the judge AI cost (one extra call per attempt) but
          // surfaces craft↔market disagreement, which is the most
          // actionable signal. Off by default — opt-in per project.
          const dualJudgeEnabled = currentProject.context?.dualJudge === true;

          if (judge && isQualityCandidate && qualityLoopEnabled && response.length > 500) {
            let attempt = 0;
            let bestResponse = response;
            let bestScore = -1;
            while (attempt <= maxRetries) {
              const verdict = await judge.evaluate(response, {
                aiComplete: (r: any) => services.aiRouter.complete(r),
                aiSelectProvider: (taskType: string) => services.aiRouter.selectProvider(taskType),
                threshold: qualityThreshold,
                dualJudge: dualJudgeEnabled,
              });
              console.log(`  [judge] "${activeStep.label}" attempt ${attempt + 1}: ${verdict.summary}`);
              if (verdict.score > bestScore) {
                bestScore = verdict.score;
                bestResponse = response;
              }
              if (!verdict.retry || attempt >= maxRetries) break;

              // Retry with feedback as additional steering.
              attempt++;
              console.log(`  [judge] Retrying with feedback (attempt ${attempt + 1}/${maxRetries + 1})...`);
              const userMsgWithFeedback = userMessage +
                '\n\n## Quality feedback on your previous draft\n\n' + verdict.retryFeedback +
                '\n\nProduce a NEW draft that fixes these specific issues. Output ONLY the chapter prose — no commentary.';
              let retryResponse = '';
              try {
                await gateway.handleMessage(
                  userMsgWithFeedback,
                  'project-engine',
                  (text: string) => { retryResponse = text; },
                  projectContext,
                  activeStep.taskType || undefined,
                );
                if (retryResponse && retryResponse.length > 500 &&
                    !retryResponse.startsWith('[AI provider failure]')) {
                  response = retryResponse;
                } else {
                  // Retry failed — keep previous best and stop looping.
                  break;
                }
              } catch {
                break;
              }
            }
            // Always keep the highest-scoring version we saw.
            response = bestResponse;
            services.activityLog?.log({
              type: 'step_completed',
              source: 'internal',
              goalId: currentProject.id,
              stepLabel: activeStep.label,
              message: `Quality score: ${bestScore.toFixed(1)}/100 after ${attempt + 1} attempt(s)`,
              metadata: { qualityScore: bestScore, attempts: attempt + 1 },
            });
          }
        } catch (judgeErr) {
          // Judge failures should NEVER block step completion — degrade gracefully.
          console.warn('  [judge] evaluation hook failed:', (judgeErr as Error)?.message || judgeErr);
        }

        const wordCount = response.split(/\s+/).length;

        // Save to file
        try {
          const projectDir = join(workspaceDir, 'projects', currentProject.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          await mkdir(projectDir, { recursive: true });
          const stepFileName = `${activeStep.id}-${activeStep.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          await writeFile(join(projectDir, stepFileName), `# ${activeStep.label}\n\n${response}`, 'utf-8');
        } catch { /* non-fatal */ }

        engine.completeStep(currentProject.id, activeStep.id, response);
        // Track words for Morning Briefing
        services.heartbeat.addWords(wordCount);
        results.push({ step: activeStep.label, success: true, wordCount });

        // ── ContextEngine: summarize + extract entities for canonical chapter prose ──
        // Bug fix (2026-04): the previous heuristic matched any step whose label
        // contained "chapter" or "write" — which included "Self-review Chapter N"
        // and other analysis steps. That doubled AI cost AND polluted the entity
        // index with character/location names mentioned in critique form ("Sarah's
        // motivation feels weak" → indexed as a Sarah attribute change). Now uses
        // the precise skill+phase signal: only `skill === 'write'` (first-draft
        // chapter prose) OR `phase === 'polish'` (revised chapter prose) qualify.
        // The polish step replaces the prior summary because its chapterNumber
        // matches the write step and the summary upserts on (projectId, chapterId)
        // — so the polished version becomes canonical without dropping memory.
        try {
          const contextEngine = services.contextEngine;
          const stepLabel = (activeStep as any).label || '';
          const stepSkill = (activeStep as any).skill || '';
          const stepPhase = (activeStep as any).phase || '';
          const isCanonicalChapter = stepSkill === 'write' || stepPhase === 'polish';
          const isBibleStep = currentProject.type === 'book-bible' ||
            stepLabel.toLowerCase().includes('bible') ||
            stepLabel.toLowerCase().includes('world') ||
            (stepLabel.toLowerCase().includes('character') && stepSkill !== 'revise');

          if (contextEngine && response.length > 200 && (isCanonicalChapter || isBibleStep)) {
            const chapterNum = currentProject.steps.filter((s: any) =>
              s.status === 'completed' && s.id !== activeStep.id
            ).length + 1;

            const aiCompleteFn = (req: any) => services.aiRouter.complete(req);
            const aiSelectFn = (taskType: string) => services.aiRouter.selectProvider(taskType);

            // Await context engine calls so they complete before moving to next step
            await Promise.allSettled([
              contextEngine.generateSummary(
                currentProject.id, activeStep.id, stepLabel, chapterNum, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => console.error('[context-engine] Summary error:', err.message)),
              contextEngine.extractEntities(
                currentProject.id, activeStep.id, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => console.error('[context-engine] Entity extraction error:', err.message)),
            ]);
          }
        } catch (contextErr) {
          console.error('[context-engine] Hook error:', contextErr);
        }

        // ── Auto-narrate completed chapter (opt-in via project.context.autoNarrate) ──
        // Inspired by OpenClaw's chat-scoped /tts auto controls. Generates an audio
        // preview of the just-completed chapter so the author can listen back without
        // manually triggering the TTS endpoint. Fire-and-forget — never blocks step flow.
        try {
          const autoNarrate = !!currentProject.context?.autoNarrate;
          const stepLabel = String((activeStep as any).label || '').toLowerCase();
          // Match the same canonical-chapter signal as the ContextEngine hook so
          // we don't auto-narrate review/polish notes — only first-draft prose
          // and polished revisions get audio.
          const stepSkill = (activeStep as any).skill || '';
          const stepPhase = (activeStep as any).phase || '';
          const isWritingStep = stepSkill === 'write' || stepPhase === 'polish';
          if (autoNarrate && isWritingStep && services.tts && response.length > 200) {
            // Resolve the persona's voice if the project has one — keeps each pen
            // name's narration consistent across chapters.
            let voice: string | undefined;
            const personaId = (currentProject as any).personaId;
            if (personaId && services.personas) {
              const persona = services.personas.get?.(personaId);
              if (persona?.ttsVoice) voice = persona.ttsVoice;
            }
            // ElevenLabs costs credits per call. Cap auto-narrate text to a safe length
            // and warn in the audit log when ElevenLabs is the active provider.
            const activeProvider = services.tts.getActiveProvider();
            const cap = activeProvider === 'elevenlabs' ? 3000 : 30000;
            const narrationText = response.replace(/^#[^\n]+\n+/, '').substring(0, cap);
            services.tts.generate(narrationText, { voice })
              .then((result: any) => {
                if (result.success) {
                  services.activityLog?.log({
                    type: 'file_saved',
                    source: 'internal',
                    goalId: currentProject.id,
                    message: `🔊 Auto-narrated "${activeStep.label}" (${result.provider}, ~${result.duration}s) → ${result.filename}`,
                    metadata: { audioFile: result.filename, voice, provider: result.provider },
                  });
                } else {
                  console.error('[auto-narrate] failed:', result.error);
                }
              })
              .catch((err: any) => console.error('[auto-narrate] error:', err));
          }
        } catch (narrationErr) {
          console.error('[auto-narrate] hook error:', narrationErr);
        }

        // ── Manuscript Assembly: combine chapter files after assembly step ──
        if ((activeStep as any).phase === 'assembly' && currentProject.type === 'novel-pipeline') {
          try {
            const { existsSync: exLocal } = await import('fs');
            const { readFile: readF } = await import('fs/promises');
            const projectSlug = currentProject.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const projectDir = join(workspaceDir, 'projects', projectSlug);

            const writingSteps = currentProject.steps
              .filter((s: any) => s.phase === 'writing' && s.status === 'completed')
              .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

            const chapterContents: string[] = [];
            for (const ws of writingSteps) {
              const expectedFile = `${(ws as any).id}-${(ws as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
              const fullPath = join(projectDir, expectedFile);
              if (exLocal(fullPath)) {
                const raw = await readF(fullPath, 'utf-8');
                const content = raw.replace(/^# .+\n\n/, '');
                chapterContents.push(`## Chapter ${(ws as any).chapterNumber || chapterContents.length + 1}\n\n${content}`);
              }
            }

            if (chapterContents.length > 0) {
              const manuscriptMd = `# ${currentProject.title}\n\n` + chapterContents.join('\n\n---\n\n');
              await writeFile(join(projectDir, 'manuscript.md'), manuscriptMd, 'utf-8');

              const docxBuffer = await generateDocxBuffer({
                title: currentProject.title,
                author: 'BookClaw',
                content: manuscriptMd,
              });
              await writeFile(join(projectDir, 'manuscript.docx'), docxBuffer);
              console.log(`  [assembly] Manuscript assembled: ${chapterContents.length} chapters`);
            }
          } catch { /* non-fatal */ }
        }

        // Re-check pause AFTER step completes (catches /stop sent during long AI call)
        const freshProject = engine.getProject(req.params.id);
        if (freshProject?.status === 'paused' || freshProject?.status === 'completed') break;
      } catch (error) {
        engine.failStep(currentProject.id, activeStep.id, String(error));
        results.push({ step: activeStep.label, success: false, error: String(error) });
        break;
      }
    }

    res.json({
      success: true,
      results,
      project: engine.getProject(req.params.id),
    });
  });

  app.post('/api/projects/:id/skip/:stepId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const nextStep = engine.skipStep(req.params.id, req.params.stepId);
    res.json({ nextStep, project: engine.getProject(req.params.id) });
  });

  app.post('/api/projects/:id/pause', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    engine.pauseProject(req.params.id);
    res.json({ project: engine.getProject(req.params.id) });
  });

  // ── Resume a stuck/completed project that still has pending or active steps ──
  app.post('/api/projects/:id/resume', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Fix orphaned active steps — reset all but the first to pending
    const activeSteps = project.steps.filter((s: any) => s.status === 'active');
    if (activeSteps.length > 1) {
      // Keep only the first active step, reset the rest to pending
      for (let i = 1; i < activeSteps.length; i++) {
        activeSteps[i].status = 'pending';
      }
    }

    // If all remaining steps are 'pending' but none are 'active', activate the first one
    const hasActive = project.steps.some((s: any) => s.status === 'active');
    if (!hasActive) {
      const nextPending = project.steps.find((s: any) => s.status === 'pending');
      if (nextPending) nextPending.status = 'active';
    }

    // Set project status back to active
    const remaining = project.steps.filter((s: any) => s.status === 'pending' || s.status === 'active');
    if (remaining.length > 0) {
      project.status = 'active';
      delete (project as any).completedAt;
      project.updatedAt = new Date().toISOString();
    }

    // Recalculate progress
    const done = project.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);

    res.json({
      resumed: true,
      status: project.status,
      progress: project.progress,
      activeStep: project.steps.find((s: any) => s.status === 'active')?.label || null,
      remainingSteps: remaining.length,
    });
  });

  // ── Update a project's preferred provider ──
  app.post('/api/projects/:id/provider', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { provider } = req.body;
    const valid = ['gemini', 'deepseek', 'claude', 'openai', 'ollama', '', null];
    if (!valid.includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    (project as any).preferredProvider = provider || undefined;
    project.updatedAt = new Date().toISOString();
    res.json({ success: true, preferredProvider: (project as any).preferredProvider || null });
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }

    // Get project info before deleting (to find files on disk)
    const project = engine.getProject(req.params.id);
    const deleteFiles = req.query.files === 'true';

    const deleted = engine.deleteProject(req.params.id);

    // Optionally delete workspace files too
    let filesDeleted = 0;
    if (deleted && deleteFiles && project) {
      try {
        const { join: j } = await import('path');
        const { rm } = await import('fs/promises');
        const { existsSync: ex } = await import('fs');
        const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
        if (ex(projectDir)) {
          const { readdir } = await import('fs/promises');
          const entries = await readdir(projectDir);
          filesDeleted = entries.length;
          await rm(projectDir, { recursive: true });
        }
      } catch { /* non-fatal */ }
    }

    res.json({ success: deleted, filesDeleted });
  });

}
