/**
 * wave3-gated routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { addWaveDisclaimer } from '../context.js';

export function registerWave3GatedRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ─── Browser Doctor ───
  // Read-only probe inspired by OpenClaw's `browser doctor` command. Reports
  // whether AuthorClaw can plan browser actions for each major author platform.
  // Does NOT navigate or click anything — purely descriptive.
  app.get('/api/browser/doctor', (_req: Request, res: Response) => {
    const planners = {
      kdp: {
        planner: !!services.launchOrchestrator,
        description: 'Amazon KDP — pre-order setup, launch-day publish, price pulse',
        confirmationGated: true,
        notes: 'KDP automation requires a Claude-in-Chrome MCP session in the user\'s authenticated browser. AuthorClaw produces the plan; the MCP executes after explicit approval.',
      },
      amsAds: {
        planner: !!services.amsAds,
        description: 'Amazon Advertising — campaign creation, bid optimization',
        confirmationGated: true,
        notes: 'Bid changes capped at 2x per confirmation. Daily spend ceilings hard-enforced.',
      },
      bookbub: {
        planner: !!services.bookbub,
        description: 'BookBub Featured Deal — submission draft + rationale',
        confirmationGated: true,
        notes: 'AuthorClaw never fabricates editorial review quotes. Review snippets must be flagged as verified before submission.',
      },
      website: {
        planner: !!services.websiteBuilder,
        description: 'Author website — static site generation + deploy guidance',
        confirmationGated: false,
        notes: 'Website Builder writes files locally; deploy is user-driven.',
      },
      translation: {
        planner: !!services.translationPipeline,
        description: 'Foreign-rights pipeline — DeepL + Claude post-edit',
        confirmationGated: true,
        notes: 'France-bound translations require AI-disclosure acknowledgment.',
      },
    };
    const all = Object.values(planners);
    const ready = all.filter(p => p.planner).length;
    res.json({
      version: 'browser-doctor/v1',
      summary: `${ready} of ${all.length} planners ready. AuthorClaw is planner-first; an external browser MCP (e.g., Claude in Chrome) executes approved actions.`,
      planners,
      gateStatus: services.confirmationGate
        ? `Confirmation gate active. ${services.confirmationGate.list({ status: 'pending' }).length} pending request(s).`
        : 'Confirmation gate NOT initialized — refusing to execute browser actions.',
      executor: {
        kind: 'external-mcp',
        recommended: 'Claude in Chrome',
        details: 'AuthorClaw does not bundle a browser driver. Connect Claude-in-Chrome MCP (or your preferred browser-automation MCP) and it will pick up approved confirmations.',
      },
      safetyRails: [
        'Every irreversible action passes through ConfirmationGateService',
        '24-hour expiry on unreviewed confirmations',
        'Pre-auth claims in observed content are auto-rejected',
        'AI-disclosure acknowledgment required before publish/upload',
        'Spend caps hard-enforced on financial actions',
        'Passwords never stored — sessions reuse the user\'s authenticated browser',
      ],
    });
  });

  app.get('/api/confirmations', (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.json({ requests: [], disclaimer: '' });
    const status = req.query.status as any;
    const service = req.query.service as any;
    addWaveDisclaimer(res);
    res.json({
      requests: gate.list({ status, service }),
      disclaimer: services.disclosures?.universalDisclaimer() || '',
    });
  });

  app.get('/api/confirmations/:id', (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    const req_ = gate.get(req.params.id);
    if (!req_) return res.status(404).json({ error: 'Not found' });
    addWaveDisclaimer(res);
    res.json({ request: req_ });
  });

  app.post('/api/confirmations/:id/approve', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    try {
      const result = await gate.approve(req.params.id);
      if (!result) return res.status(404).json({ error: 'Not found' });
      addWaveDisclaimer(res);
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Approval failed' });
    }
  });

  app.post('/api/confirmations/:id/reject', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    try {
      const result = await gate.reject(req.params.id, 'user', req.body?.reason);
      if (!result) return res.status(404).json({ error: 'Not found' });
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Rejection failed' });
    }
  });

  app.post('/api/confirmations/:id/outcome', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    const { success, message, externalId, metadata } = req.body || {};
    if (typeof success !== 'boolean' || !message) {
      return res.status(400).json({ error: 'success (boolean) and message (string) required' });
    }
    try {
      const result = await gate.recordOutcome(req.params.id, {
        success, message, externalId, executedAt: new Date().toISOString(), metadata,
      });
      if (!result) return res.status(404).json({ error: 'Not found' });
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Outcome recording failed' });
    }
  });

  // ── Disclosures ──

  app.get('/api/disclosures/universal', (_req: Request, res: Response) => {
    const d = services.disclosures;
    if (!d) return res.status(503).json({ error: 'Disclosures not initialized' });
    res.json({ text: d.universalDisclaimer() });
  });

  app.post('/api/disclosures/check', (req: Request, res: Response) => {
    const d = services.disclosures;
    if (!d) return res.status(503).json({ error: 'Disclosures not initialized' });
    const { platform, scopes, acknowledgedScopes } = req.body || {};
    if (!platform || !Array.isArray(scopes)) {
      return res.status(400).json({ error: 'platform and scopes (array) required' });
    }
    const result = d.checkCompliance({
      platform, scopes,
      acknowledgedScopes: Array.isArray(acknowledgedScopes) ? acknowledgedScopes : [],
    });
    res.json(result);
  });

  // ── Launch Orchestrator ──

  app.get('/api/launches', (_req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.json({ launches: [] });
    addWaveDisclaimer(res);
    res.json({ launches: l.listLaunches() });
  });

  app.post('/api/launches', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { projectId, bookTitle, authorName, targetReleaseDate, metadata } = req.body || {};
    if (!projectId || !bookTitle || !authorName || !targetReleaseDate) {
      return res.status(400).json({ error: 'projectId, bookTitle, authorName, targetReleaseDate required' });
    }
    const launch = await l.createLaunch({ projectId, bookTitle, authorName, targetReleaseDate, metadata });
    addWaveDisclaimer(res);
    res.json({ launch });
  });

  app.get('/api/launches/:id', (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const launch = l.getLaunch(req.params.id);
    if (!launch) return res.status(404).json({ error: 'Not found' });
    res.json({ launch, plan: l.buildPlan(launch) });
  });

  app.patch('/api/launches/:id', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const result = await l.updateMetadata(req.params.id, req.body?.metadata || {});
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ launch: result });
  });

  app.post('/api/launches/:id/acknowledge-disclosures', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { scopes } = req.body || {};
    if (!Array.isArray(scopes)) return res.status(400).json({ error: 'scopes (array) required' });
    const result = await l.acknowledgeDisclosures(req.params.id, scopes);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ launch: result });
  });

  app.post('/api/launches/:id/propose-step', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { phase } = req.body || {};
    if (!phase) return res.status(400).json({ error: 'phase required' });
    try {
      const result = await l.proposeStep(req.params.id, phase);
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Proposal failed' });
    }
  });

  app.delete('/api/launches/:id', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const removed = await l.deleteLaunch(req.params.id);
    res.json({ success: removed });
  });

  // ── AMS Ads ──

  app.post('/api/ams/propose-campaigns', (req: Request, res: Response) => {
    const ams = services.amsAds;
    if (!ams) return res.status(503).json({ error: 'AMS service not initialized' });
    const { bookTitle, genre, keywords, dailyBudgetCeilingUSD } = req.body || {};
    if (!bookTitle || !genre || !Array.isArray(keywords) || typeof dailyBudgetCeilingUSD !== 'number') {
      return res.status(400).json({ error: 'bookTitle, genre, keywords (array), dailyBudgetCeilingUSD (number) required' });
    }
    addWaveDisclaimer(res);
    res.json({ campaigns: ams.proposeCampaigns({ bookTitle, genre, keywords, dailyBudgetCeilingUSD }) });
  });

  app.post('/api/ams/optimize', (req: Request, res: Response) => {
    const ams = services.amsAds;
    if (!ams) return res.status(503).json({ error: 'AMS service not initialized' });
    const { performance, acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD } = req.body || {};
    if (!Array.isArray(performance) || typeof acosTargetPct !== 'number'
        || typeof dailyBudgetCeilingUSD !== 'number' || typeof currentDailySpendUSD !== 'number') {
      return res.status(400).json({ error: 'performance (array), acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD required' });
    }
    addWaveDisclaimer(res);
    res.json(ams.optimize({ performance, acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD }));
  });

  // ── BookBub ──

  app.post('/api/bookbub/draft', (req: Request, res: Response) => {
    const bb = services.bookbub;
    if (!bb) return res.status(503).json({ error: 'BookBub service not initialized' });
    const { title, authorName, genre, amazonBlurb } = req.body || {};
    if (!title || !authorName || !genre || !amazonBlurb) {
      return res.status(400).json({ error: 'title, authorName, genre, amazonBlurb required' });
    }
    addWaveDisclaimer(res);
    res.json({ draft: bb.buildDraft(req.body) });
  });

  // ── Release Calendar ──

  app.get('/api/calendar', (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.json({ events: [] });
    res.json({
      events: c.list({
        projectId: req.query.projectId as any,
        category: req.query.category as any,
        from: req.query.from as any,
        to: req.query.to as any,
      }),
      atRisk: c.atRisk(),
    });
  });

  app.post('/api/calendar', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    try {
      const event = await c.createEvent(req.body);
      res.json({ event });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/calendar/price-pulse-plan', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const { projectId, bookTitle, releaseDate, launchPrice, tailPrice } = req.body || {};
    if (!projectId || !bookTitle || !releaseDate) {
      return res.status(400).json({ error: 'projectId, bookTitle, releaseDate required' });
    }
    const events = c.buildPricePulsePlan({ projectId, bookTitle, releaseDate, launchPrice, tailPrice });
    for (const ev of events) await c.createEvent(ev);
    res.json({ events });
  });

  app.patch('/api/calendar/:id', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const result = await c.updateEvent(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ event: result });
  });

  app.delete('/api/calendar/:id', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const removed = await c.removeEvent(req.params.id);
    res.json({ success: removed });
  });

  app.get('/api/calendar/export.ics', (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const ics = c.exportICS({
      projectId: req.query.projectId as any,
      from: req.query.from as any,
      to: req.query.to as any,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="authorclaw-calendar.ics"');
    res.send(ics);
  });

  // ── Reader Intel ──

  app.post('/api/reader-intel/analyze', async (req: Request, res: Response) => {
    const ri = services.readerIntel;
    if (!ri) return res.status(503).json({ error: 'Reader intel not initialized' });
    const { reviews } = req.body || {};
    if (!Array.isArray(reviews)) return res.status(400).json({ error: 'reviews (array) required' });
    try {
      const sanitized = await ri.sanitize(reviews);
      const report = ri.analyze(sanitized);
      res.json({ report, sanitizedCount: sanitized.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Analysis failed' });
    }
  });

  // ── Translation Pipeline ──

  app.post('/api/translation/plan', (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { projectId, bookTitle, targetLangs, estimatedWordCount, sourceLang } = req.body || {};
    if (!projectId || !bookTitle || !Array.isArray(targetLangs) || typeof estimatedWordCount !== 'number') {
      return res.status(400).json({ error: 'projectId, bookTitle, targetLangs (array), estimatedWordCount (number) required' });
    }
    addWaveDisclaimer(res);
    res.json(tp.plan({ projectId, bookTitle, targetLangs, estimatedWordCount, sourceLang }));
  });

  app.post('/api/translation/propose', async (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { projectId, bookTitle, targetLang, estimatedWordCount, sampleText } = req.body || {};
    if (!projectId || !bookTitle || !targetLang || typeof estimatedWordCount !== 'number') {
      return res.status(400).json({ error: 'projectId, bookTitle, targetLang, estimatedWordCount required' });
    }
    try {
      const result = await tp.proposeTranslation({ projectId, bookTitle, targetLang, estimatedWordCount, sampleText });
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Proposal failed' });
    }
  });

  // Execute an APPROVED translation. The user must first approve the
  // ConfirmationRequest from /propose; this runs the gated translation and
  // records the outcome back on the confirmation gate.
  app.post('/api/translation/execute', async (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });

    const {
      confirmationId, manuscript, text, projectId,
      targetLanguage, sourceLanguage, glossary, tier, preferredProvider,
    } = req.body || {};

    if (!confirmationId || typeof confirmationId !== 'string') {
      return res.status(400).json({ error: "confirmationId (string) required — user must approve the translation request first" });
    }
    if (!targetLanguage) {
      return res.status(400).json({ error: 'targetLanguage required' });
    }
    if (!manuscript && !text) {
      return res.status(400).json({ error: 'manuscript (or text) with the full source text required' });
    }

    try {
      const result = await tp.executeApprovedTranslation(confirmationId, {
        manuscript, text, projectId,
        targetLanguage, sourceLanguage, glossary, tier, preferredProvider,
      });
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      const msg = err?.message || 'Translation failed';
      const status = /not 'approved'|not found|expired|rejected/i.test(msg) ? 409 : 500;
      res.status(status).json({ error: msg });
    }
  });

  app.post('/api/translation/rights-pitch', (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { targetLang, bookTitle, authorName, genre, wordCountApprox, comps, marketingAngle } = req.body || {};
    if (!targetLang || !bookTitle || !authorName || !genre || typeof wordCountApprox !== 'number') {
      return res.status(400).json({ error: 'targetLang, bookTitle, authorName, genre, wordCountApprox required' });
    }
    res.json(tp.generateRightsPitch({ targetLang, bookTitle, authorName, genre, wordCountApprox, comps, marketingAngle }));
  });

}
