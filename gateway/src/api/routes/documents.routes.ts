import { Application, Request, Response } from 'express';
import multer from 'multer';
import { safePath, upload } from './_shared.js';
import { generateDocxBuffer } from '../../services/docx-export.js';
import { generateEpubBuffer } from '../../services/epub-export.js';

/** Document library (large-manuscript storage), project/library uploads, and the Context Engine / continuity checker. */
export function mountDocuments(app: Application, gateway: any, baseDir: string): void {
  const services = gateway.getServices();

  // ═══════════════════════════════════════════════════════════
  // Document Library (centralized document storage for large manuscripts)
  // ═══════════════════════════════════════════════════════════

  // List all documents in the library
  app.get('/api/documents', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const docsDir = j(baseDir, 'workspace', 'documents');
    if (!ex(docsDir)) {
      return res.json({ documents: [] });
    }

    try {
      const entries = await rd(docsDir);
      const docs: Array<{ filename: string; size: number; wordCount?: number; uploadedAt?: string }> = [];

      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'metadata.json') continue;
        const fullPath = j(docsDir, entry);
        const info = await st(fullPath);
        if (!info.isFile()) continue;

        let wordCount: number | undefined;
        const ext = entry.split('.').pop()?.toLowerCase();
        if (ext === 'txt' || ext === 'md') {
          try {
            const text = await rf(fullPath, 'utf-8');
            wordCount = text.split(/\s+/).filter(Boolean).length;
          } catch { /* skip */ }
        }

        docs.push({
          filename: entry,
          size: info.size,
          wordCount,
          uploadedAt: info.mtime.toISOString(),
        });
      }

      // Load metadata for word counts of docx files
      const metaPath = j(docsDir, 'metadata.json');
      let metadata: Record<string, any> = {};
      if (ex(metaPath)) {
        try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
      }
      for (const doc of docs) {
        if (!doc.wordCount && metadata[doc.filename]?.wordCount) {
          doc.wordCount = metadata[doc.filename].wordCount;
        }
      }

      res.json({ documents: docs });
    } catch {
      res.json({ documents: [] });
    }
  });

  // Upload a document directly to the library (not tied to a project)
  app.post('/api/documents/upload', multer({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max for library
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
  }).single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { join: j } = await import('path');
    const { mkdir: mkd, writeFile: wf, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const docsDir = j(baseDir, 'workspace', 'documents');
    await mkd(docsDir, { recursive: true });

    const filename = req.file.originalname;
    const ext = filename.split('.').pop()?.toLowerCase();

    // Save the raw file
    await wf(j(docsDir, filename), req.file.buffer);

    // Extract text and word count
    let textContent = '';
    if (ext === 'txt' || ext === 'md') {
      textContent = req.file.buffer.toString('utf-8');
    } else if (ext === 'docx') {
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(req.file.buffer);
        const docEntry = zip.getEntry('word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          const paragraphs: string[] = [];
          const paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
          for (const para of paraMatches) {
            const textParts = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
            if (textParts) {
              const line = textParts.map(t => t.replace(/<[^>]+>/g, '')).join('');
              if (line.trim()) paragraphs.push(line);
            }
          }
          textContent = paragraphs.join('\n\n');
        }
      } catch { /* ok */ }

      // Save extracted text alongside for fast access
      if (textContent) {
        const textFilename = filename.replace(/\.docx$/i, '.extracted.txt');
        await wf(j(docsDir, textFilename), textContent);
      }
    }

    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    // Save metadata
    const metaPath = j(docsDir, 'metadata.json');
    let metadata: Record<string, any> = {};
    if (ex(metaPath)) {
      try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
    }
    metadata[filename] = {
      wordCount,
      uploadedAt: new Date().toISOString(),
      size: req.file.size,
    };
    await wf(metaPath, JSON.stringify(metadata, null, 2));

    res.json({
      success: true,
      filename,
      wordCount,
      size: req.file.size,
      library: true,
      preview: textContent.substring(0, 200),
    });
  });

  // Delete a document from the library
  app.delete('/api/documents/:filename', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { unlink, readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const filename = String(req.params.filename);
    const docsDir = j(baseDir, 'workspace', 'documents');
    const filePath = safePath(docsDir, filename);

    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await unlink(filePath);

    // Also delete extracted text if it exists
    const extractedName = filename.replace(/\.docx$/i, '.extracted.txt');
    const extractedPath = safePath(docsDir, extractedName);
    if (extractedPath && ex(extractedPath) && extractedPath !== filePath) {
      try { await unlink(extractedPath); } catch { /* ok */ }
    }

    // Update metadata
    const metaPath = j(docsDir, 'metadata.json');
    if (ex(metaPath)) {
      try {
        const metadata = JSON.parse(await rf(metaPath, 'utf-8'));
        delete metadata[filename];
        await wf(metaPath, JSON.stringify(metadata, null, 2));
      } catch { /* ok */ }
    }

    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Document Upload (project-level + auto-library for large files)
  // ═══════════════════════════════════════════════════════════


  app.post('/api/projects/:id/upload', upload.single('file'), async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { join: j } = await import('path');
    const { mkdir: mkd, writeFile: wf, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    let textContent = '';
    // Sanitize filename to prevent path traversal (strip path separators, .., null bytes)
    const rawName = req.file.originalname || 'upload';
    const filename = rawName
      .replace(/[\x00-\x1f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.\.+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 200) || 'upload';
    const ext = filename.split('.').pop()?.toLowerCase();

    if (ext === 'txt' || ext === 'md') {
      textContent = req.file.buffer.toString('utf-8');
    } else if (ext === 'docx') {
      // Extract text from docx — unzip the archive and parse word/document.xml
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(req.file.buffer);
        const docEntry = zip.getEntry('word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          // Extract text from <w:t> tags, preserving paragraph breaks
          const paragraphs: string[] = [];
          const paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
          for (const para of paraMatches) {
            const textParts = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
            if (textParts) {
              const line = textParts.map(t => t.replace(/<[^>]+>/g, '')).join('');
              if (line.trim()) paragraphs.push(line);
            }
          }
          textContent = paragraphs.join('\n\n');
          if (!textContent.trim()) {
            textContent = '[Empty document — no text found in .docx]';
          }
        } else {
          textContent = '[Could not find document content in .docx — file may be corrupted]';
        }
      } catch (e) {
        textContent = '[Failed to parse .docx file: ' + String(e) + ']';
      }
    }

    // Save the file to project upload directory
    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const uploadDir = j(baseDir, 'workspace', 'projects', projectSlug, 'uploads');
    await mkd(uploadDir, { recursive: true });
    await wf(j(uploadDir, filename), req.file.buffer);

    const wordCount = textContent.split(/\s+/).filter(Boolean).length;
    const LARGE_THRESHOLD = 15000; // 15K words = "large" manuscript
    const isLarge = wordCount > LARGE_THRESHOLD;

    // For large manuscripts (15K+ words): save to centralized document library
    // The full text stays on disk — only smart excerpts go into AI context
    if (isLarge) {
      const docsDir = j(baseDir, 'workspace', 'documents');
      await mkd(docsDir, { recursive: true });

      // Save the extracted text to the library for fast access at execution time
      const textFilename = filename.replace(/\.\w+$/, '.txt');
      await wf(j(docsDir, textFilename), textContent);
      // Save original file too
      await wf(j(docsDir, filename), req.file.buffer);

      // Save metadata
      const metaPath = j(docsDir, 'metadata.json');
      let metadata: Record<string, any> = {};
      if (ex(metaPath)) {
        try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
      }
      metadata[textFilename] = {
        wordCount,
        uploadedAt: new Date().toISOString(),
        size: textContent.length,
        originalFilename: filename,
        projectId: project.id,
      };
      await wf(metaPath, JSON.stringify(metadata, null, 2));

      console.log(`  📚 Large manuscript saved to document library: ${textFilename} (${wordCount.toLocaleString()} words)`);
    }

    // Store upload info in project context
    if (!project.context.uploads) project.context.uploads = [];
    project.context.uploads.push({
      filename,
      wordCount,
      preview: textContent.substring(0, 500),
      uploadedAt: new Date().toISOString(),
      isLarge,
      libraryFile: isLarge ? filename.replace(/\.\w+$/, '.txt') : undefined,
    });

    // Store document content for AI steps
    // For large documents: store reference path (read from disk at execution time)
    // For small documents: store inline (same as before)
    if (isLarge) {
      // Store the path for on-demand reading at execution time
      const textFilename = filename.replace(/\.\w+$/, '.txt');
      project.context.documentLibraryFile = j(baseDir, 'workspace', 'documents', textFilename);
      project.context.documentWordCount = wordCount;
      // Store a brief excerpt for the system context (so AI knows what it's working with)
      if (!project.context.uploadedContent) project.context.uploadedContent = '';
      project.context.uploadedContent += `\n\n--- Uploaded: ${filename} (${wordCount.toLocaleString()} words — full text loaded from document library) ---\n`;
      project.context.uploadedContent += textContent.substring(0, 2000);
      project.context.uploadedContent += `\n\n[...${wordCount.toLocaleString()} words total — smart excerpt will be injected at execution time...]\n`;
    } else {
      // Small file: store inline as before
      if (!project.context.uploadedContent) project.context.uploadedContent = '';
      project.context.uploadedContent += `\n\n--- Uploaded: ${filename} ---\n${textContent}`;
    }

    res.json({
      success: true,
      filename,
      wordCount,
      preview: textContent.substring(0, 200),
      isLarge,
      savedToLibrary: isLarge,
    });
  });

  // ── Workspace File Management ──

  app.get('/api/workspace/stats', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const workspaceDir = j(baseDir, 'workspace');

    const stats: Record<string, { files: number; size: number; items?: string[] }> = {};

    async function scanDir(name: string, dirPath: string, listItems = true) {
      if (!ex(dirPath)) { stats[name] = { files: 0, size: 0 }; return; }
      try {
        const entries = await rd(dirPath, { recursive: true });
        let totalSize = 0;
        let fileCount = 0;
        const items: string[] = [];
        for (const entry of entries) {
          try {
            const fp = j(dirPath, String(entry));
            const s = await st(fp);
            if (s.isFile()) { fileCount++; totalSize += s.size; if (listItems) items.push(String(entry)); }
          } catch { /* skip */ }
        }
        stats[name] = { files: fileCount, size: totalSize, items: listItems ? items.slice(0, 50) : undefined };
      } catch { stats[name] = { files: 0, size: 0 }; }
    }

    await Promise.all([
      scanDir('projects', j(workspaceDir, 'projects')),
      scanDir('research', j(workspaceDir, 'research')),
      scanDir('exports', j(workspaceDir, 'exports')),
      scanDir('agent', j(workspaceDir, '.agent'), false),
      scanDir('memory', j(workspaceDir, '.memory'), false),
      scanDir('audio', j(workspaceDir, '.audio')),
    ]);

    const totalFiles = Object.values(stats).reduce((sum, s) => sum + s.files, 0);
    const totalSize = Object.values(stats).reduce((sum, s) => sum + s.size, 0);
    res.json({ totalFiles, totalSize, totalSizeFormatted: (totalSize / 1048576).toFixed(1) + ' MB', breakdown: stats });
  });

  app.delete('/api/workspace/clean', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { rm } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const workspaceDir = j(baseDir, 'workspace');

    const target = String(req.query.target || '');
    const allowed = ['projects', 'research', 'exports', 'audio'];
    if (!allowed.includes(target)) {
      return res.status(400).json({ error: `Target must be one of: ${allowed.join(', ')}` });
    }

    const dirName = target === 'audio' ? '.audio' : target;
    const targetDir = j(workspaceDir, dirName);
    let deleted = 0;

    if (ex(targetDir)) {
      try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(targetDir);
        deleted = entries.length;
        await rm(targetDir, { recursive: true });
      } catch (e) {
        return res.status(500).json({ error: String(e) });
      }
    }

    res.json({ success: true, target, deleted });
  });

  // ── Project File Listing ──

  app.get('/api/projects/:id/files', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j } = await import('path');
    const { readdir: rd, stat: st } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    if (!ex(projectDir)) return res.json({ files: [] });

    try {
      const entries = await rd(projectDir);
      const files: Array<{ name: string; size: number; type: string }> = [];
      for (const entry of entries) {
        if (entry === 'uploads') continue; // skip uploads subfolder
        const fullPath = j(projectDir, entry);
        const info = await st(fullPath);
        if (!info.isFile()) continue;
        const ext = entry.split('.').pop()?.toLowerCase() || '';
        files.push({ name: entry, size: info.size, type: ext });
      }
      // Sort: manuscript files first, then by name
      files.sort((a, b) => {
        const aManuscript = a.name.startsWith('manuscript') ? 0 : 1;
        const bManuscript = b.name.startsWith('manuscript') ? 0 : 1;
        if (aManuscript !== bManuscript) return aManuscript - bManuscript;
        return a.name.localeCompare(b.name);
      });
      res.json({ files, projectDir: projectSlug });
    } catch {
      res.json({ files: [] });
    }
  });

  // ── Project File Download ──

  app.get('/api/projects/:id/download/:filename', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j, resolve: rv } = await import('path');
    const { existsSync: ex } = await import('fs');

    const filename = String(req.params.filename);
    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
    const filePath = safePath(projectDir, filename);

    // Security: ensure the resolved path is inside the project directory
    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Set content disposition for download
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      md: 'text/markdown',
      txt: 'text/plain',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      html: 'text/html',
      json: 'application/json',
      mp3: 'audio/mpeg',
      epub: 'application/epub+zip',
    };
    res.setHeader('Content-Type', mimeTypes[ext || ''] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // ── Export single file as DOCX ──
  app.post('/api/projects/:id/export-docx', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const { join: j, resolve: rv } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
    const sourcePath = safePath(projectDir, String(filename));

    if (!sourcePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    if (!ex(sourcePath)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    try {
      const content = await rf(sourcePath, 'utf-8');
      const docxName = String(filename).replace(/\.md$/i, '.docx');
      const docxBuffer = await generateDocxBuffer({
        title: project.title,
        author: 'Author',
        content,
      });
      await wf(j(projectDir, docxName), docxBuffer);
      res.json({
        success: true,
        downloadUrl: `/api/projects/${req.params.id}/download/${encodeURIComponent(docxName)}`,
      });
    } catch (err) {
      res.status(500).json({ error: 'DOCX export failed: ' + String(err) });
    }
  });

  // ── Compile Project Files (combine all output files into one document) ──

  app.post('/api/projects/:id/compile', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j } = await import('path');
    const { readdir: rd, readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    if (!ex(projectDir)) return res.status(404).json({ error: 'No project files found' });

    try {
      const entries = await rd(projectDir);
      const sectionContents: string[] = [];
      const isChapterProject = project.type === 'book-production' || project.type === 'novel-pipeline';
      const isDeepRevision = project.type === 'deep-revision';
      let revisionReportContent: string | null = null;  // Analysis reports saved separately

      // ── Deep Revision compile: use the FINAL revision-apply step output as the book ──
      // Without this branch, users got 21 concatenated analysis reports instead of the revised manuscript.
      if (isDeepRevision) {
        // Find the last completed revision_apply step (the final polish pass).
        const applySteps = project.steps
          .filter((s: any) => s.phase === 'revision_apply' && s.status === 'completed');
        const finalApplyStep = applySteps[applySteps.length - 1];

        if (finalApplyStep) {
          const expectedFile = `${(finalApplyStep as any).id}-${(finalApplyStep as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          const fullPath = j(projectDir, expectedFile);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            // Strip the leading "# <label>" heading we saved with so downstream doesn't double-wrap it.
            const content = raw.replace(/^# .+\n\n/, '');
            sectionContents.push(content);
            console.log(`  [deep-revision] Using "${finalApplyStep.label}" output as the compiled revised manuscript (${content.length} chars).`);
          }
        }

        // Gather all the analysis reports (non-apply completed steps) into a separate report file.
        const analysisSteps = project.steps.filter((s: any) =>
          s.status === 'completed' && s.phase !== 'revision_apply'
        );
        if (analysisSteps.length > 0) {
          const reportSections: string[] = [];
          for (const as of analysisSteps) {
            const filename = `${(as as any).id}-${(as as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
            const fullPath = j(projectDir, filename);
            if (ex(fullPath)) {
              const raw = await rf(fullPath, 'utf-8');
              reportSections.push(raw.startsWith('# ') ? raw : `## ${as.label}\n\n${raw}`);
            }
          }
          if (reportSections.length > 0) {
            revisionReportContent = `# ${project.title} — Revision Report\n\n` +
              `This report contains the full diagnostic analysis from ${reportSections.length} revision passes. ` +
              `Your revised manuscript is saved separately as \`manuscript.md\` / \`manuscript.docx\` / \`manuscript.epub\`.\n\n---\n\n` +
              reportSections.join('\n\n---\n\n');
          }
        }

        // If no revision_apply step has run yet, fall through to the universal path below,
        // but warn the caller so the dashboard can surface it.
        if (sectionContents.length === 0) {
          return res.status(400).json({
            error: 'Revised manuscript not ready',
            detail: 'The revision-apply steps have not completed yet. Finish running the project (or trigger the "Apply line-level revisions" step) before compiling. The analysis-only reports alone are not a revised book.',
          });
        }
      }

      if (isChapterProject) {
        // ── Chapter-based compile (book-production / novel-pipeline) ──
        // For each chapter, prefer the POLISH step's output (revised prose)
        // over the WRITE step's output (first draft). Falls back to write
        // if polish hasn't run yet OR for legacy projects that don't have
        // a polish phase. This was the source of the "compile is empty"
        // bug — old code mixed write + review notes for the same chapter
        // because both shared `phase: 'writing'`.
        const completedChapterSteps = project.steps
          .filter((s: any) => s.status === 'completed' &&
                              (s.phase === 'writing' || s.phase === 'polish') &&
                              (s.chapterNumber || s.skill === 'write' || s.skill === 'revise'));

        // Group by chapterNumber, preferring polish over write.
        const chapterPicks = new Map<number, any>();
        for (const s of completedChapterSteps) {
          const ch = (s as any).chapterNumber || 0;
          const existing = chapterPicks.get(ch);
          if (!existing) {
            chapterPicks.set(ch, s);
          } else if (s.phase === 'polish' && existing.phase !== 'polish') {
            chapterPicks.set(ch, s);
          }
          // If both exist and current pick is already polish, keep it.
        }

        const writingSteps = Array.from(chapterPicks.values())
          .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

        for (const ws of writingSteps) {
          const expectedFile = `${(ws as any).id}-${(ws as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          const fullPath = j(projectDir, expectedFile);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            const content = raw.replace(/^# .+\n\n/, '');
            sectionContents.push(`## Chapter ${(ws as any).chapterNumber || sectionContents.length + 1}\n\n${content}`);
          }
        }

        // Fallback: find chapter files by filename pattern
        if (sectionContents.length === 0) {
          const chapterFiles = entries
            .filter(f => f.match(/write-chapter-\d+\.md$/))
            .sort((a, b) => {
              const numA = parseInt(a.match(/chapter-(\d+)/)?.[1] || '0');
              const numB = parseInt(b.match(/chapter-(\d+)/)?.[1] || '0');
              return numA - numB;
            });
          for (const cf of chapterFiles) {
            const raw = await rf(j(projectDir, cf), 'utf-8');
            const content = raw.replace(/^# .+\n\n/, '');
            const chNum = parseInt(cf.match(/chapter-(\d+)/)?.[1] || '0');
            sectionContents.push(`## Chapter ${chNum}\n\n${content}`);
          }
        }
      }

      // ── Universal compile: collect ALL step output .md files ──
      if (sectionContents.length === 0) {
        // Get completed steps in order to determine file sequence
        const completedSteps = project.steps
          .filter((s: any) => s.status === 'completed')
          .map((s: any) => ({
            id: s.id,
            label: s.label,
            filename: `${s.id}-${s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
          }));

        // First: collect files that match completed steps (preserves step order)
        const usedFiles = new Set<string>();
        for (const cs of completedSteps) {
          const fullPath = j(projectDir, cs.filename);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            sectionContents.push(raw.startsWith('# ') ? raw : `## ${cs.label}\n\n${raw}`);
            usedFiles.add(cs.filename);
          }
        }

        // Second: pick up any other .md files not already included (research files, extras)
        const remainingMd = entries
          .filter(f => f.endsWith('.md') && !usedFiles.has(f) && f !== 'manuscript.md' && f !== 'compiled-output.md')
          .sort();
        for (const mf of remainingMd) {
          const raw = await rf(j(projectDir, mf), 'utf-8');
          sectionContents.push(raw);
          usedFiles.add(mf);
        }
      }

      if (sectionContents.length === 0) {
        return res.status(400).json({ error: 'No output files found to compile' });
      }

      // Build compiled document
      const compiledMd = `# ${project.title}\n\n` + sectionContents.join('\n\n---\n\n');
      // Deep-revision produces a real revised manuscript, so name it 'manuscript' (not 'compiled-output').
      const outputBaseName = (isChapterProject || isDeepRevision) ? 'manuscript' : 'compiled-output';
      await wf(j(projectDir, `${outputBaseName}.md`), compiledMd, 'utf-8');

      // For revision projects, save the diagnostic report as a companion file so users can download both.
      if (isDeepRevision && revisionReportContent) {
        await wf(j(projectDir, 'revision-report.md'), revisionReportContent, 'utf-8');
      }

      // Get persona info for metadata
      const personaId = (project as any).personaId;
      const persona = personaId ? services.personas?.get(personaId) : null;
      const authorName = persona?.penName || 'BookClaw';

      const exportFiles = [`${outputBaseName}.md`];

      // Generate DOCX
      try {
        const docxBuffer = await generateDocxBuffer({
          title: project.title,
          author: authorName,
          content: compiledMd,
          authorBio: persona?.bio,
          alsoBy: persona?.alsoBy,
        });
        await wf(j(projectDir, `${outputBaseName}.docx`), docxBuffer);
        exportFiles.push(`${outputBaseName}.docx`);
      } catch { /* DOCX generation is non-fatal */ }

      // Generate EPUB
      try {
        const epubBuffer = await generateEpubBuffer({
          title: project.title,
          author: authorName,
          content: compiledMd,
          description: project.description,
          authorBio: persona?.bio,
        });
        await wf(j(projectDir, `${outputBaseName}.epub`), epubBuffer);
        exportFiles.push(`${outputBaseName}.epub`);
      } catch { /* EPUB generation is non-fatal */ }

      const totalWords = compiledMd.split(/\s+/).length;
      // Report the revision-report companion file too, so the dashboard can offer a download link.
      if (isDeepRevision && revisionReportContent) exportFiles.push('revision-report.md');
      res.json({
        success: true,
        sections: sectionContents.length,
        totalWords,
        files: exportFiles,
        outputName: outputBaseName,
        kind: isDeepRevision ? 'revised-manuscript' : (isChapterProject ? 'manuscript' : 'compiled-output'),
        hasRevisionReport: isDeepRevision && !!revisionReportContent,
      });
    } catch (err) {
      res.status(500).json({ error: 'Compile failed: ' + String(err) });
    }
  });

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

}
