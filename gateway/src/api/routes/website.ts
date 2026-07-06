/**
 * website routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import { addWaveDisclaimer } from '../context.js';

export function registerWebsiteRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ── Website Builder ──

  app.get('/api/websites', async (_req: Request, res: Response) => {
    const w = services.websiteBuilder;
    if (!w) return res.json({ sites: [] });
    const sites = await w.listSites();
    res.json({ sites });
  });

  app.post('/api/websites/build', async (req: Request, res: Response) => {
    const w = services.websiteBuilder;
    if (!w) return res.status(503).json({ error: 'Website builder not initialized' });
    const { config, books, blogPosts, aboutHTML, contactHTML } = req.body || {};
    if (!config || !config.slug || !config.siteName || !config.authorName || !config.baseUrl) {
      return res.status(400).json({ error: 'config with slug, siteName, authorName, baseUrl required' });
    }
    try {
      const result = await w.build({
        config,
        books: Array.isArray(books) ? books : [],
        blogPosts: Array.isArray(blogPosts) ? blogPosts : [],
        aboutHTML, contactHTML,
      });
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Build failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Website Site Registry (management layer over the static-site builder)
  // ═══════════════════════════════════════════════════════════

  /** GET /api/sites — list all registered sites + their freshness status. */
  app.get('/api/sites', (_req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    res.json({ sites: services.websiteSites.list() });
  });

  app.get('/api/sites/:siteId', (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const site = services.websiteSites.get(req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json(site);
  });

  app.post('/api/sites', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const { config, linkedProjectIds, deploy } = req.body || {};
    if (!config?.slug || !config?.siteName || !config?.authorName || !config?.baseUrl) {
      return res.status(400).json({ error: 'config with slug, siteName, authorName, baseUrl required' });
    }
    try {
      const site = await services.websiteSites.create({ config, linkedProjectIds, deploy });
      res.json({ site });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Site create failed' });
    }
  });

  app.patch('/api/sites/:siteId', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const site = await services.websiteSites.update(req.params.siteId, req.body || {});
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  app.delete('/api/sites/:siteId', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const removed = await services.websiteSites.delete(req.params.siteId);
    res.json({ success: removed });
  });

  app.post('/api/sites/:siteId/link-project', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const site = await services.websiteSites.linkProject(req.params.siteId, projectId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  app.post('/api/sites/:siteId/unlink-project', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const { projectId } = req.body || {};
    const site = await services.websiteSites.unlinkProject(req.params.siteId, projectId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  /** Add or replace a book on a site (manual; the auto-hook does this on
   *  project completion when projects are linked). */
  app.post('/api/sites/:siteId/books', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const book = req.body;
    if (!book?.title || !book?.blurb) return res.status(400).json({ error: 'book.title + book.blurb required' });
    const site = await services.websiteSites.autoAddBook(req.params.siteId, book);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  app.delete('/api/sites/:siteId/books/:bookSlug', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const site = await services.websiteSites.removeBook(req.params.siteId, req.params.bookSlug);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  // ── Blog post management ──

  app.post('/api/sites/:siteId/blog-posts', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const post = req.body;
    if (!post?.title || !post?.bodyHTML) return res.status(400).json({ error: 'post.title + post.bodyHTML required' });
    if (!post.slug) post.slug = String(post.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    if (!post.date) post.date = new Date().toISOString();
    const site = await services.websiteSites.addBlogPost(req.params.siteId, post);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  app.delete('/api/sites/:siteId/blog-posts/:postSlug', async (req: Request, res: Response) => {
    if (!services.websiteSites) return res.status(503).json({ error: 'Site registry not initialized' });
    const site = await services.websiteSites.removeBlogPost(req.params.siteId, req.params.postSlug);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  });

  /**
   * Draft a blog post from a project. Author reviews + edits + adds to site
   * via the /api/sites/:siteId/blog-posts endpoint above.
   *
   * Body: { siteId?, postType, projectId, excerptText?, authorAngle?, preferredProvider? }
   * If siteId is provided, the draft is auto-added to the site's blog queue
   * (unrendered + unpublished — author still has to render + deploy).
   */
  app.post('/api/blog-posts/draft', async (req: Request, res: Response) => {
    if (!services.blogPostDrafter) return res.status(503).json({ error: 'Blog drafter not initialized' });
    const { postType, projectId, excerptText, authorAngle, preferredProvider, siteId } = req.body || {};
    if (!postType || !projectId) return res.status(400).json({ error: 'postType + projectId required' });
    const validTypes = ['release_announcement', 'behind_the_scenes', 'excerpt', 'teaser'];
    if (!validTypes.includes(postType)) return res.status(400).json({ error: `postType must be one of: ${validTypes.join(', ')}` });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const persona = (project as any).personaId ? services.personas?.get?.((project as any).personaId) : null;

    // Pull artifacts: chapter summaries from ContextEngine if behind-the-scenes,
    // user-model narrative if available, voice signature if Style Clone has run.
    const artifacts: any = {};
    if ((postType === 'behind_the_scenes' || postType === 'release_announcement') && services.contextEngine) {
      try {
        const ctx = await services.contextEngine.loadContext(projectId);
        artifacts.chapterSummaries = (ctx?.summaries || []).map((s: any) => ({
          chapterNumber: s.chapterNumber,
          summary: s.summary || s.endingState || '',
        }));
      } catch { /* non-fatal */ }
    }
    if (postType === 'behind_the_scenes' && services.userModel) {
      const snap = services.userModel.getSnapshot();
      if (snap?.narrative?.text) artifacts.userModelNarrative = snap.narrative.text;
    }

    try {
      const result = await services.blogPostDrafter.draft(
        { postType, projectId, excerptText, authorAngle, preferredProvider },
        {
          id: project.id,
          title: project.title,
          description: project.description,
          type: project.type,
          genre: (project as any).context?.genre || persona?.genre,
          personaId: (project as any).personaId,
          authorName: persona?.penName,
          buyLinks: (project as any).context?.buyLinks,
          comps: (project as any).context?.comps,
          releaseDate: (project as any).context?.releaseDate,
        },
        artifacts,
        {
          aiComplete: (r: any) => services.aiRouter.complete(r),
          aiSelectProvider: (taskType: string) => services.aiRouter.selectProvider(taskType),
        },
      );

      // If a siteId was provided, auto-add the draft to that site's queue.
      if (siteId && services.websiteSites) {
        await services.websiteSites.addBlogPost(siteId, result.post);
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Draft failed' });
    }
  });

  // ── Render + deploy ──

  /** Render the site's HTML using the WebsiteBuilder. Sets lastRenderedAt. */
  app.post('/api/sites/:siteId/render', async (req: Request, res: Response) => {
    if (!services.websiteSites || !services.websiteBuilder) {
      return res.status(503).json({ error: 'Required services not initialized' });
    }
    const site = services.websiteSites.get(req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    try {
      const result = await services.websiteBuilder.build({
        config: site.config,
        books: site.books,
        blogPosts: site.blogPosts,
        aboutHTML: site.aboutHTML,
        contactHTML: site.contactHTML,
      });
      await services.websiteSites.markRendered(site.id);
      addWaveDisclaimer(res);
      res.json({ rendered: true, site, result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Render failed' });
    }
  });

  /** Deploy the site using its configured target. Probes the doctor first. */
  app.post('/api/sites/:siteId/deploy', async (req: Request, res: Response) => {
    if (!services.websiteSites || !services.websiteDeploy) {
      return res.status(503).json({ error: 'Required services not initialized' });
    }
    const site = services.websiteSites.get(req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (!site.lastRenderedAt) {
      return res.status(400).json({ error: 'Site has not been rendered yet. POST /api/sites/:siteId/render first.' });
    }
    const siteDir = path.join(baseDir, 'workspace', 'website', site.id);
    try {
      const result = await services.websiteDeploy.deploy({
        siteId: site.id,
        deployConfig: req.body?.deployConfig || site.deploy,
        siteDir,
        workspaceDir: path.join(baseDir, 'workspace'),
      });
      if (result.success) await services.websiteSites.markDeployed(site.id);
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Deploy failed' });
    }
  });

  /** Combined: render + deploy in one call. */
  app.post('/api/sites/:siteId/publish', async (req: Request, res: Response) => {
    if (!services.websiteSites || !services.websiteBuilder || !services.websiteDeploy) {
      return res.status(503).json({ error: 'Required services not initialized' });
    }
    const site = services.websiteSites.get(req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    try {
      const buildResult = await services.websiteBuilder.build({
        config: site.config,
        books: site.books,
        blogPosts: site.blogPosts,
        aboutHTML: site.aboutHTML,
        contactHTML: site.contactHTML,
      });
      await services.websiteSites.markRendered(site.id);
      const deployResult = await services.websiteDeploy.deploy({
        siteId: site.id,
        deployConfig: req.body?.deployConfig || site.deploy,
        siteDir: buildResult.outputDir,
        workspaceDir: path.join(baseDir, 'workspace'),
      });
      if (deployResult.success) await services.websiteSites.markDeployed(site.id);
      addWaveDisclaimer(res);
      res.json({ build: buildResult, deploy: deployResult });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Publish failed' });
    }
  });

  /** Doctor — which deploy targets are usable on this machine.
   *  Lives at /api/site-deploy/doctor (NOT /api/sites/deploy-doctor) so
   *  it doesn't get shadowed by the `/api/sites/:siteId` parameter route. */
  app.get('/api/site-deploy/doctor', async (_req: Request, res: Response) => {
    if (!services.websiteDeploy) return res.status(503).json({ error: 'Deploy not initialized' });
    res.json(await services.websiteDeploy.doctor());
  });
}
