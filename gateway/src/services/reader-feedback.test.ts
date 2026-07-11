import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ReaderFeedbackService,
  findLabeledNumber,
  stripTags,
  originOf,
  safeJson,
  MIN_REQUEST_SPACING_MS,
  READER_FEEDBACK_USER_AGENT,
  type ReaderFeedbackHttpGet,
  type ReaderFeedbackDeps,
} from './reader-feedback.js';

// ── Fixtures ──────────────────────────────────────────────

const FICTION_HTML = `
<!DOCTYPE html><html><head>
<meta property="og:title" content="The Clockwork Moat" />
</head><body>
<h1>The Clockwork Moat</h1>
<ul class="stats">
  <li><span>Followers</span><span>12,340</span></li>
  <li><span>Favorites</span><span>3,001</span></li>
  <li><span>Ratings</span><span>842</span></li>
  <li><span>Pages</span><span>1,205</span></li>
  <li><span>Total Views</span><span>2,450,900</span></li>
</ul>
<div aria-label="4.6 stars" class="star"></div>
<table id="chapters">
  <tr><td><a href="/fiction/999/clockwork-moat/chapter/1/awakening">Chapter 1: Awakening</a></td><td><time datetime="2026-01-01T00:00:00Z">Jan 1</time></td></tr>
  <tr><td><a href="/fiction/999/clockwork-moat/chapter/2/descent">Chapter 2: Descent</a></td><td><time datetime="2026-01-08T00:00:00Z">Jan 8</time></td></tr>
  <tr><td><a href="https://www.royalroad.com/fiction/999/clockwork-moat/chapter/3/the-gate">Chapter 3: The Gate</a></td><td><time datetime="2026-01-15T00:00:00Z">Jan 15</time></td></tr>
</table>
</body></html>`;

const CHAPTER_HTML = `
<html><body>
<div class="comment">
  <div class="comment-content">Loved the pacing here! The gate reveal gave me chills.</div>
</div>
<div class="comment">
  <div class="comment-body">Please give Mira more screen time, she's the best character.</div>
</div>
<div class="comment">
  <div class="comment-text">The middle dragged a bit but the ending saved it.</div>
</div>
</body></html>`;

const FICTION_URL = 'https://www.royalroad.com/fiction/999/clockwork-moat';

/** Build a service against a fresh temp workspace. */
async function makeService(overrides: Partial<ReaderFeedbackDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rf-test-'));
  const svc = new ReaderFeedbackService({
    workspaceDir: dir,
    // Deterministic clock + no-op sleep by default.
    now: () => 1_000_000,
    sleep: async () => {},
    ...overrides,
  });
  await svc.initialize();
  return { svc, dir };
}

// ── Pure helpers ──────────────────────────────────────────

describe('pure helpers', () => {
  it('findLabeledNumber pulls comma-formatted numbers next to a label', () => {
    expect(findLabeledNumber(FICTION_HTML, 'Followers')).toBe(12340);
    expect(findLabeledNumber(FICTION_HTML, 'Total Views')).toBe(2450900);
    expect(findLabeledNumber(FICTION_HTML, 'Nonexistent')).toBeUndefined();
  });
  it('decodes numeric HTML entities (hex + decimal)', () => {
    expect(stripTags('Life&#x2019;s Little Problems').trim()).toBe("Life’s Little Problems");
    expect(stripTags('caf&#233;').trim()).toBe('café');
  });
  it('stripTags + originOf + safeJson behave', () => {
    expect(stripTags('<b>hi &amp; bye</b>').trim()).toBe('hi & bye');
    expect(originOf(FICTION_URL)).toBe('https://www.royalroad.com');
    expect(safeJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(safeJson('garbage')).toBeNull();
  });
});

// ── Config store roundtrip ────────────────────────────────

describe('config store', () => {
  it('roundtrips config to disk (atomic store)', async () => {
    const { svc, dir } = await makeService();
    expect(svc.getConfig('p1')).toBeNull();
    const cfg = await svc.setConfig('p1', { platform: 'royalroad', fictionUrl: FICTION_URL });
    expect(cfg).toEqual({ platform: 'royalroad', fictionUrl: FICTION_URL, enabled: true });

    // Persisted + reload in a fresh instance sees it.
    const raw = JSON.parse(await readFile(join(dir, 'data', 'reader-feedback.json'), 'utf-8'));
    expect(raw.p1.config.fictionUrl).toBe(FICTION_URL);

    const svc2 = new ReaderFeedbackService({ workspaceDir: dir });
    await svc2.initialize();
    expect(svc2.getConfig('p1')?.fictionUrl).toBe(FICTION_URL);
  });

  it('rejects invalid platform + missing url', async () => {
    const { svc } = await makeService();
    await expect(svc.setConfig('p1', { platform: 'facebook' as any, fictionUrl: FICTION_URL })).rejects.toThrow(/platform/i);
    await expect(svc.setConfig('p1', { platform: 'royalroad', fictionUrl: 'not-a-url' })).rejects.toThrow(/fictionUrl/i);
  });
});

// ── Royal Road parsing (fixture, no network) ──────────────

describe('Royal Road parsers', () => {
  it('parses fiction stats from fixture HTML', async () => {
    const { svc } = await makeService();
    const warnings: string[] = [];
    const stats = svc.parseFictionStats(FICTION_HTML, warnings);
    expect(stats.title).toBe('The Clockwork Moat');
    expect(stats.followers).toBe(12340);
    expect(stats.favorites).toBe(3001);
    expect(stats.ratings).toBe(842);
    expect(stats.pages).toBe(1205);
    expect(stats.views).toBe(2450900);
    expect(stats.score).toBe(4.6);
    expect(warnings).toHaveLength(0);
  });

  it('parses the chapter list with resolved absolute URLs + dates', async () => {
    const { svc } = await makeService();
    const warnings: string[] = [];
    const chapters = svc.parseChapterList(FICTION_HTML, FICTION_URL, warnings);
    expect(chapters).toHaveLength(3);
    expect(chapters[0].title).toBe('Chapter 1: Awakening');
    expect(chapters[0].url).toBe('https://www.royalroad.com/fiction/999/clockwork-moat/chapter/1/awakening');
    expect(chapters[2].url).toBe('https://www.royalroad.com/fiction/999/clockwork-moat/chapter/3/the-gate');
    expect(chapters[0].date).toBe('2026-01-01T00:00:00Z');
  });

  it('filters out the "Start Reading" CTA that also links to a chapter', async () => {
    const { svc } = await makeService();
    const html = FICTION_HTML.replace(
      '<table id="chapters">',
      '<a href="/fiction/999/clockwork-moat/chapter/1/awakening" class="btn">Start Reading</a><table id="chapters">',
    );
    const chapters = svc.parseChapterList(html, FICTION_URL, []);
    expect(chapters.map(c => c.title)).not.toContain('Start Reading');
    expect(chapters).toHaveLength(3);
  });

  it('parses comments from a chapter page', async () => {
    const { svc } = await makeService();
    const comments = svc.parseComments(CHAPTER_HTML);
    expect(comments).toHaveLength(3);
    expect(comments[0]).toMatch(/Loved the pacing/);
    expect(comments[1]).toMatch(/Mira/);
  });

  it('degrades gracefully on unparseable HTML (warnings, no throw)', async () => {
    const { svc } = await makeService();
    const warnings: string[] = [];
    const stats = svc.parseFictionStats('<html>totally different</html>', warnings);
    expect(stats).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
    const chapters = svc.parseChapterList('<html>nope</html>', FICTION_URL, warnings);
    expect(chapters).toEqual([]);
    expect(svc.parseComments('<html>nope</html>')).toEqual([]);
  });
});

// ── Retention proxy ───────────────────────────────────────

describe('retention drop computation', () => {
  it('computes chapter-over-chapter view dropoff', async () => {
    const { svc } = await makeService();
    const out = svc.computeRetention([
      { title: 'c1', views: 1000 },
      { title: 'c2', views: 800 },
      { title: 'c3', views: 600 },
    ]);
    expect(out[0].retentionDropVsPrev).toBeUndefined();
    expect(out[1].retentionDropVsPrev).toBeCloseTo(0.2, 5);
    expect(out[2].retentionDropVsPrev).toBeCloseTo(0.25, 5);
  });
  it('leaves drop undefined when views are missing', async () => {
    const { svc } = await makeService();
    const out = svc.computeRetention([{ title: 'c1' }, { title: 'c2', views: 500 }]);
    expect(out[1].retentionDropVsPrev).toBeUndefined();
  });
});

// ── Rate-limit spacing (injectable clock) ─────────────────

describe('polite request spacing', () => {
  it('waits the remaining gap when requests are too close', async () => {
    let clock = 100_000;
    const { svc } = await makeService({ now: () => clock, sleep: async () => {} });
    // lastRequestAt 500ms ago → must wait MIN - 500.
    expect(svc.computeSpacingWait(clock - 500)).toBe(MIN_REQUEST_SPACING_MS - 500);
    // lastRequestAt beyond the window → no wait.
    expect(svc.computeSpacingWait(clock - MIN_REQUEST_SPACING_MS - 1)).toBe(0);
    // First request (0 sentinel) → no wait.
    expect(svc.computeSpacingWait(0)).toBe(0);
  });
});

// ── Full sync (Royal Road) with fixture httpGet ───────────

describe('sync — Royal Road end to end (fixture httpGet)', () => {
  function fixtureHttp(): { get: ReaderFeedbackHttpGet; calls: string[]; uaSeen: string[] } {
    const calls: string[] = [];
    const uaSeen: string[] = [];
    const get: ReaderFeedbackHttpGet = async (url, headers) => {
      calls.push(url);
      uaSeen.push(headers['User-Agent']);
      if (url === FICTION_URL) return { ok: true, status: 200, text: FICTION_HTML };
      if (url.includes('/chapter/')) return { ok: true, status: 200, text: CHAPTER_HTML };
      return { ok: false, status: 404, text: '' };
    };
    return { get, calls, uaSeen };
  }

  it('fetches with the honest UA and produces a full report; comment summary uses FREE tier only', async () => {
    const { get, calls, uaSeen } = fixtureHttp();
    const aiComplete = vi.fn(async () => ({
      text: '{"themes":["pacing praised","wants more Mira"],"whatReadersAreTellingYou":["Give Mira a POV scene next chapter"]}',
      tokensUsed: 10, estimatedCost: 0, provider: 'gemini-free',
    }));
    const aiSelectProvider = vi.fn((_t: string) => ({ id: 'gemini-free', tier: 'free' }));

    const { svc } = await makeService({ httpGet: get, aiComplete, aiSelectProvider });
    await svc.setConfig('p1', { platform: 'royalroad', fictionUrl: FICTION_URL });
    const report = await svc.sync('p1');

    expect(report.source).toBe('live');
    expect(report.fictionStats.followers).toBe(12340);
    expect(report.chapters).toHaveLength(3);
    // Retention proxy exists structurally (undefined views → undefined drop is fine).
    expect(report.commentThemes.source).toBe('free-ai');
    expect(report.commentThemes.themes).toContain('pacing praised');
    expect(report.commentThemes.whatReadersAreTellingYou.length).toBeGreaterThan(0);

    // Honest UA on every request.
    expect(uaSeen.every(ua => ua === READER_FEEDBACK_USER_AGENT)).toBe(true);
    // Fiction page + up to 3 chapter comment pages, within the request cap.
    expect(calls[0]).toBe(FICTION_URL);
    expect(calls.length).toBeLessThanOrEqual(10);
    // Only free-tier task types requested.
    for (const c of aiSelectProvider.mock.calls) expect(['general', 'marketing']).toContain(c[0]);

    // Report is cached + retrievable.
    expect(svc.getReport('p1')?.fictionStats.followers).toBe(12340);
  });

  it('fails closed on a PAID provider — summary skipped, no AI call spent', async () => {
    const { get } = fixtureHttp();
    const aiComplete = vi.fn(async () => ({ text: '{}', tokensUsed: 0, estimatedCost: 0, provider: 'x' }));
    const aiSelectProvider = vi.fn((_t: string) => ({ id: 'claude', tier: 'paid' }));

    const { svc } = await makeService({ httpGet: get, aiComplete, aiSelectProvider });
    await svc.setConfig('p1', { platform: 'royalroad', fictionUrl: FICTION_URL });
    const report = await svc.sync('p1');

    expect(report.commentThemes.source).toBe('skipped');
    expect(aiComplete).not.toHaveBeenCalled();
    expect(report.warnings.some(w => /cost rule/i.test(w))).toBe(true);
  });

  it('degrades gracefully when the fiction page 404s (warnings, no throw)', async () => {
    const get: ReaderFeedbackHttpGet = async () => ({ ok: false, status: 404, text: '' });
    const { svc } = await makeService({ httpGet: get });
    await svc.setConfig('p1', { platform: 'royalroad', fictionUrl: FICTION_URL });
    const report = await svc.sync('p1');
    expect(report.source).toBe('live');
    expect(report.chapters).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

// ── Wattpad stub ──────────────────────────────────────────

describe('Wattpad', () => {
  it('returns an honest unsupported report of the same shape', async () => {
    const { svc } = await makeService();
    await svc.setConfig('p2', { platform: 'wattpad', fictionUrl: 'https://www.wattpad.com/story/123' });
    const report = await svc.sync('p2');
    expect(report.source).toBe('unsupported');
    expect(report.platform).toBe('wattpad');
    expect(report.message).toMatch(/not supported/i);
    expect(report.chapters).toEqual([]);
    expect(report.commentThemes.source).toBe('skipped');
  });
});

// ── Route module registration (mock app) ─────────────────

describe('registerReaderFeedbackRoutes', () => {
  it('registers the four config/sync/report endpoints on the app', async () => {
    const { registerReaderFeedbackRoutes } = await import('../api/routes/reader-feedback.js');
    const routes: Array<{ method: string; path: string }> = [];
    const app: any = {
      get: (path: string) => routes.push({ method: 'GET', path }),
      post: (path: string) => routes.push({ method: 'POST', path }),
    };
    registerReaderFeedbackRoutes({ app, gateway: {}, services: {}, baseDir: '.' } as any);
    const sigs = routes.map(r => `${r.method} ${r.path}`);
    expect(sigs).toContain('GET /api/projects/:id/reader-feedback/config');
    expect(sigs).toContain('POST /api/projects/:id/reader-feedback/config');
    expect(sigs).toContain('POST /api/projects/:id/reader-feedback/sync');
    expect(sigs).toContain('GET /api/projects/:id/reader-feedback/report');
  });
});

// ── syncAll (cron shape) ──────────────────────────────────

describe('syncAll (cron entry point)', () => {
  it('syncs only enabled projects and returns a cron-shaped result', async () => {
    const get: ReaderFeedbackHttpGet = async () => ({ ok: true, status: 200, text: FICTION_HTML });
    const { svc } = await makeService({ httpGet: get });
    await svc.setConfig('p1', { platform: 'royalroad', fictionUrl: FICTION_URL, enabled: true });
    await svc.setConfig('p2', { platform: 'royalroad', fictionUrl: FICTION_URL, enabled: false });
    const res = await svc.syncAll();
    expect(res.success).toBe(true);
    expect(res.details.projects).toHaveLength(1);
    expect(res.details.projects[0].projectId).toBe('p1');
  });
});
