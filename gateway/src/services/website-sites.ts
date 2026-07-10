/**
 * AuthorAgent Website Site Registry
 *
 * The management layer on top of WebsiteBuilderService. WebsiteBuilder
 * generates static HTML from a config + a books list + a blog list each
 * time it's called. This service maintains the persistent state behind
 * those calls — the registry of sites, which projects feed into which
 * site, which blog posts are queued, when each was last rendered, when
 * each was last deployed.
 *
 * Deliberately NOT a CMS:
 *   - No comments / forms / interactive features
 *   - No ESP / analytics integration (authors paste their own embed codes)
 *   - No SEO panel (we already auto-generate sitemap/RSS/OG tags)
 *   - No themes marketplace
 *   - No multi-tenancy (local-first; one author's machine, one set of sites)
 *
 * What it DOES do:
 *   - Track which projects are featured on which site
 *   - Auto-add a book to a site when a linked project completes
 *   - Hold a queue of blog post drafts (the BlogPostDrafter writes them;
 *     the author reviews them; this service tracks status)
 *   - Track render and deploy timestamps so the dashboard can show
 *     "site is X behind your latest book" status
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { WebsiteSiteConfig, WebsiteBook, WebsiteBlogPost } from './website-builder.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type DeployTarget = 'netlify' | 'vercel' | 'cloudflare-pages' | 'github-pages' | 'rsync' | 'manual-zip' | 'none';

export interface DeployConfig {
  target: DeployTarget;
  /** Adapter-specific options. */
  options?: {
    /** Netlify: site ID. Vercel: project name. CF Pages: project name.
     *  rsync: destination user@host:/path. */
    destination?: string;
    /** Optional environment variable name that holds the deploy token —
     *  read from .env / process.env at deploy time. We never store the
     *  token itself in this config. */
    tokenEnvVar?: string;
    /** github-pages: the git remote URL to push to, e.g.
     *  `https://github.com/author/author-site.git` or an SSH remote
     *  (`git@github.com:author/author-site.git`). Required for github-pages. */
    repo?: string;
    /** github-pages: branch to force-push the rendered site to.
     *  Defaults to `gh-pages`. */
    branch?: string;
  };
}

export interface PersistedSite {
  /** Unique slug. Also used as the directory under workspace/website/. */
  id: string;
  config: WebsiteSiteConfig;
  /** ProjectIds whose completed books should appear on this site. */
  linkedProjectIds: string[];
  /** Books currently published on the site. */
  books: WebsiteBook[];
  /** Blog post queue (drafts + published). */
  blogPosts: WebsiteBlogPost[];
  aboutHTML?: string;
  contactHTML?: string;
  deploy: DeployConfig;
  /** ISO timestamps for visibility into freshness. */
  createdAt: string;
  updatedAt: string;
  lastRenderedAt: string | null;
  lastDeployedAt: string | null;
  /** Author-side flag: this many changes happened since last render. */
  pendingChanges: number;
}

export interface SiteRegistryState {
  sites: Record<string, PersistedSite>;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class WebsiteSiteService {
  private state: SiteRegistryState = { sites: {} };
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'website-sites.json');
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.sites && typeof parsed.sites === 'object') {
        this.state.sites = parsed.sites;
      }
    } catch {
      // Corrupted — start fresh.
    }
  }

  // ── CRUD ──

  /** List all registered sites, sorted by most recently updated. */
  list(): PersistedSite[] {
    return Object.values(this.state.sites).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  get(siteId: string): PersistedSite | undefined {
    return this.state.sites[siteId];
  }

  async create(input: {
    config: WebsiteSiteConfig;
    linkedProjectIds?: string[];
    deploy?: DeployConfig;
  }): Promise<PersistedSite> {
    const id = this.sanitizeSlug(input.config.slug);
    if (this.state.sites[id]) {
      throw new Error(`Site with slug "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const site: PersistedSite = {
      id,
      config: { ...input.config, slug: id },
      linkedProjectIds: input.linkedProjectIds || [],
      books: [],
      blogPosts: [],
      deploy: input.deploy || { target: 'none' },
      createdAt: now,
      updatedAt: now,
      lastRenderedAt: null,
      lastDeployedAt: null,
      pendingChanges: 0,
    };
    this.state.sites[id] = site;
    await this.persist();
    return site;
  }

  async update(siteId: string, patch: Partial<Omit<PersistedSite, 'id' | 'createdAt'>>): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    Object.assign(site, patch);
    site.updatedAt = new Date().toISOString();
    site.pendingChanges = (site.pendingChanges ?? 0) + 1;
    await this.persist();
    return site;
  }

  async delete(siteId: string): Promise<boolean> {
    if (!this.state.sites[siteId]) return false;
    delete this.state.sites[siteId];
    await this.persist();
    return true;
  }

  // ── Linked-project + book management ──

  /** Add a project ID to the site's "feature these books" list. */
  async linkProject(siteId: string, projectId: string): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    if (!site.linkedProjectIds.includes(projectId)) {
      site.linkedProjectIds.push(projectId);
      site.updatedAt = new Date().toISOString();
      site.pendingChanges++;
      await this.persist();
    }
    return site;
  }

  async unlinkProject(siteId: string, projectId: string): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    const before = site.linkedProjectIds.length;
    site.linkedProjectIds = site.linkedProjectIds.filter(id => id !== projectId);
    if (site.linkedProjectIds.length !== before) {
      site.updatedAt = new Date().toISOString();
      site.pendingChanges++;
      await this.persist();
    }
    return site;
  }

  /**
   * Auto-add a book to a site when a linked project completes. Idempotent
   * on (siteId, book.slug). Called from the project-completion hook.
   *
   * Sets pendingChanges so the dashboard can show "site needs render."
   */
  async autoAddBook(siteId: string, book: WebsiteBook): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    const slug = this.sanitizeSlug(book.slug || book.title);
    const existingIdx = site.books.findIndex(b => this.sanitizeSlug(b.slug || b.title) === slug);
    if (existingIdx >= 0) {
      // Update existing entry (book may have been re-rendered with new blurb / cover).
      site.books[existingIdx] = { ...site.books[existingIdx], ...book, slug };
    } else {
      site.books.unshift({ ...book, slug }); // newest first
    }
    site.updatedAt = new Date().toISOString();
    site.pendingChanges++;
    await this.persist();
    return site;
  }

  async removeBook(siteId: string, bookSlug: string): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    const before = site.books.length;
    site.books = site.books.filter(b => this.sanitizeSlug(b.slug || b.title) !== this.sanitizeSlug(bookSlug));
    if (site.books.length !== before) {
      site.updatedAt = new Date().toISOString();
      site.pendingChanges++;
      await this.persist();
    }
    return site;
  }

  // ── Blog post management ──

  async addBlogPost(siteId: string, post: WebsiteBlogPost): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    const slug = this.sanitizeSlug(post.slug || post.title);
    const existingIdx = site.blogPosts.findIndex(p => this.sanitizeSlug(p.slug || p.title) === slug);
    if (existingIdx >= 0) {
      site.blogPosts[existingIdx] = { ...site.blogPosts[existingIdx], ...post, slug };
    } else {
      site.blogPosts.unshift({ ...post, slug });
    }
    site.updatedAt = new Date().toISOString();
    site.pendingChanges++;
    await this.persist();
    return site;
  }

  async removeBlogPost(siteId: string, postSlug: string): Promise<PersistedSite | null> {
    const site = this.state.sites[siteId];
    if (!site) return null;
    const before = site.blogPosts.length;
    site.blogPosts = site.blogPosts.filter(p => this.sanitizeSlug(p.slug || p.title) !== this.sanitizeSlug(postSlug));
    if (site.blogPosts.length !== before) {
      site.updatedAt = new Date().toISOString();
      site.pendingChanges++;
      await this.persist();
    }
    return site;
  }

  // ── Render + deploy state tracking ──

  async markRendered(siteId: string): Promise<void> {
    const site = this.state.sites[siteId];
    if (!site) return;
    site.lastRenderedAt = new Date().toISOString();
    site.pendingChanges = 0;
    await this.persist();
  }

  async markDeployed(siteId: string): Promise<void> {
    const site = this.state.sites[siteId];
    if (!site) return;
    site.lastDeployedAt = new Date().toISOString();
    await this.persist();
  }

  /** Find sites that should receive an auto-add when project P completes. */
  findSitesForProject(projectId: string): PersistedSite[] {
    return Object.values(this.state.sites).filter(s =>
      s.linkedProjectIds.includes(projectId)
    );
  }

  // ── Helpers ──

  private sanitizeSlug(s: string): string {
    return String(s || 'untitled').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'untitled';
  }

  private async persist(): Promise<void> {
    try {
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist website-sites:', err);
    }
  }
}
