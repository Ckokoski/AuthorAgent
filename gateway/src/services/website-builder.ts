/**
 * AuthorAgent Website Builder
 *
 * Builds a static author website from the author's personas, projects, and
 * blog posts. Generates HTML + CSS + JSON feeds on disk at
 * workspace/website/<slug>/. Designed to deploy to any static host
 * (Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3 + CloudFront, etc.)
 * — AuthorAgent builds locally; the user deploys the output directory.
 *
 * Pages produced:
 *   - index.html         (home / hero)
 *   - books.html         (library)
 *   - book/<slug>.html   (per-book landing page)
 *   - blog/index.html    (blog list)
 *   - blog/<slug>.html   (per-post)
 *   - about.html         (persona bio)
 *   - contact.html       (mailto: link + optional embedded form snippet)
 *   - feed.xml           (RSS 2.0)
 *   - sitemap.xml        (for SEO)
 *   - robots.txt
 *
 * Safety rails:
 *   - Every generated page with affiliate links includes the FTC disclosure
 *     automatically.
 *   - Newsletter-signup embeds are commented-out placeholders — the author
 *     must paste their ESP's embed code because we can't know their list.
 *   - CSP-friendly output: no inline scripts, no external scripts unless the
 *     author explicitly adds them.
 *   - Contact form is mailto: only by default — no server-side handler.
 *     Adding a handler (Formspree, Netlify Forms, etc.) is the author's call.
 *   - No user input is rendered into HTML without escaping.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface WebsiteSiteConfig {
  slug: string;                     // Directory name under workspace/website/
  siteName: string;
  tagline?: string;
  authorName: string;
  personaId?: string;
  baseUrl: string;                  // e.g. https://your-pen-name.com — used for sitemap + rss
  primaryColor?: string;
  fontFamily?: string;
  social?: {
    twitter?: string; instagram?: string; tiktok?: string;
    goodreads?: string; amazon?: string; bookbub?: string;
    website?: string;
  };
  includesAffiliateLinks?: boolean; // Gates FTC disclosure inclusion
  newsletterEmbedHTML?: string;     // Author-provided ESP embed
  analyticsSnippet?: string;        // Author-provided (Plausible, GA4, etc.)
}

export interface WebsiteBook {
  slug: string;
  title: string;
  subtitle?: string;
  coverImagePath?: string;          // Path relative to the site root (user uploads)
  blurb: string;                    // Already sanitized HTML (KDP-safe subset)
  buyLinks?: Array<{ label: string; url: string; isAffiliate?: boolean }>;
  releaseDate?: string;
  seriesName?: string;
  seriesNumber?: number;
  genre?: string;
  formats?: Array<'ebook' | 'paperback' | 'hardcover' | 'audiobook'>;
}

export interface WebsiteBlogPost {
  slug: string;
  title: string;
  date: string;                     // ISO
  author?: string;
  excerpt?: string;
  bodyHTML: string;                 // Pre-sanitized
  tags?: string[];
  includesAffiliateLinks?: boolean;
}

export interface WebsiteBuildInput {
  config: WebsiteSiteConfig;
  books: WebsiteBook[];
  blogPosts: WebsiteBlogPost[];
  aboutHTML?: string;
  contactHTML?: string;
}

export interface WebsiteBuildResult {
  outputDir: string;
  pagesWritten: string[];
  warnings: string[];
  deployReadme: string;             // Markdown explaining how to deploy
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const FTC_DISCLOSURE = `As an Amazon Associate and other affiliate-program participant, I earn from qualifying purchases. This page contains affiliate links. I may receive a commission if you make a purchase through one of these links at no additional cost to you.`;

export class WebsiteBuilderService {
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /**
   * Build the full static site to workspace/website/<slug>/.
   * Returns the output directory path plus a list of pages and warnings.
   */
  async build(input: WebsiteBuildInput): Promise<WebsiteBuildResult> {
    const slug = this.sanitizeSlug(input.config.slug);
    const outputDir = join(this.workspaceDir, 'website', slug);
    await mkdir(outputDir, { recursive: true });
    await mkdir(join(outputDir, 'book'), { recursive: true });
    await mkdir(join(outputDir, 'blog'), { recursive: true });

    const warnings: string[] = [];
    const written: string[] = [];

    // Safety scan.
    if (input.config.analyticsSnippet && /<script[^>]*src=/i.test(input.config.analyticsSnippet)) {
      warnings.push('Analytics snippet contains an external <script src>. Ensure the provider is trusted and that its CSP is acceptable.');
    }
    if (input.config.newsletterEmbedHTML && !/unsubscribe/i.test(input.config.newsletterEmbedHTML)) {
      warnings.push('Newsletter embed does not appear to reference an unsubscribe link. Verify your ESP template includes one (required by CAN-SPAM + GDPR).');
    }

    const css = this.buildCSS(input.config);
    await writeFile(join(outputDir, 'styles.css'), css, 'utf-8'); written.push('styles.css');

    const indexHTML = this.buildIndex(input);
    await writeFile(join(outputDir, 'index.html'), indexHTML, 'utf-8'); written.push('index.html');

    const booksHTML = this.buildBooksPage(input);
    await writeFile(join(outputDir, 'books.html'), booksHTML, 'utf-8'); written.push('books.html');

    for (const book of input.books) {
      const bookHTML = this.buildBookPage(book, input);
      const slug = this.sanitizeSlug(book.slug || book.title);
      await writeFile(join(outputDir, 'book', `${slug}.html`), bookHTML, 'utf-8');
      written.push(`book/${slug}.html`);
    }

    const blogIndexHTML = this.buildBlogIndex(input);
    await writeFile(join(outputDir, 'blog', 'index.html'), blogIndexHTML, 'utf-8'); written.push('blog/index.html');

    for (const post of input.blogPosts) {
      const postHTML = this.buildBlogPost(post, input);
      const slug = this.sanitizeSlug(post.slug || post.title);
      await writeFile(join(outputDir, 'blog', `${slug}.html`), postHTML, 'utf-8');
      written.push(`blog/${slug}.html`);
    }

    const aboutHTML = this.buildAboutPage(input);
    await writeFile(join(outputDir, 'about.html'), aboutHTML, 'utf-8'); written.push('about.html');

    const contactHTML = this.buildContactPage(input);
    await writeFile(join(outputDir, 'contact.html'), contactHTML, 'utf-8'); written.push('contact.html');

    const feedXML = this.buildRSS(input);
    await writeFile(join(outputDir, 'feed.xml'), feedXML, 'utf-8'); written.push('feed.xml');

    const sitemapXML = this.buildSitemap(input, written);
    await writeFile(join(outputDir, 'sitemap.xml'), sitemapXML, 'utf-8'); written.push('sitemap.xml');

    const robots = `User-agent: *\nAllow: /\nSitemap: ${input.config.baseUrl.replace(/\/$/, '')}/sitemap.xml\n`;
    await writeFile(join(outputDir, 'robots.txt'), robots, 'utf-8'); written.push('robots.txt');

    const deployReadme = this.buildDeployReadme(input.config, outputDir);
    await writeFile(join(outputDir, 'DEPLOY.md'), deployReadme, 'utf-8'); written.push('DEPLOY.md');

    return { outputDir, pagesWritten: written, warnings, deployReadme };
  }

  // ── Page builders ──

  private buildIndex(input: WebsiteBuildInput): string {
    const { config, books } = input;
    const latestBook = books[0];
    const content = `
<section class="hero">
  <h1>${this.esc(config.siteName)}</h1>
  ${config.tagline ? `<p class="tagline">${this.esc(config.tagline)}</p>` : ''}
</section>
${latestBook ? `
<section class="featured-book">
  <h2>Latest release</h2>
  <article class="book">
    ${latestBook.coverImagePath ? `<img src="${this.esc(latestBook.coverImagePath)}" alt="Cover of ${this.esc(latestBook.title)}" loading="lazy" />` : ''}
    <div>
      <h3>${this.esc(latestBook.title)}</h3>
      ${latestBook.subtitle ? `<p class="subtitle">${this.esc(latestBook.subtitle)}</p>` : ''}
      <div class="blurb">${latestBook.blurb}</div>
      <a href="book/${this.esc(this.sanitizeSlug(latestBook.slug || latestBook.title))}.html" class="cta">Learn more →</a>
    </div>
  </article>
</section>` : ''}
<section class="cta-block">
  <a href="books.html" class="btn">All books</a>
  <a href="blog/index.html" class="btn">Blog</a>
  <a href="about.html" class="btn">About</a>
</section>
${config.newsletterEmbedHTML ? `
<section class="newsletter">
  <h2>Join the mailing list</h2>
  ${config.newsletterEmbedHTML}
</section>` : `
<!-- Newsletter signup — paste your ESP embed code into config.newsletterEmbedHTML to activate -->`}
`.trim();
    return this.shell(config, 'Home', content, false);
  }

  private buildBooksPage(input: WebsiteBuildInput): string {
    const cards = input.books.map(b => `
<article class="book-card">
  ${b.coverImagePath ? `<img src="${this.esc(b.coverImagePath)}" alt="Cover of ${this.esc(b.title)}" loading="lazy" />` : ''}
  <h3><a href="book/${this.esc(this.sanitizeSlug(b.slug || b.title))}.html">${this.esc(b.title)}</a></h3>
  ${b.seriesName ? `<p class="series">${this.esc(b.seriesName)}${b.seriesNumber ? ` · Book ${b.seriesNumber}` : ''}</p>` : ''}
  ${b.genre ? `<p class="genre">${this.esc(b.genre)}</p>` : ''}
</article>`).join('\n');

    const affiliatePresent = input.books.some(b => b.buyLinks?.some(l => l.isAffiliate));
    const content = `
<h1>Books</h1>
<div class="book-grid">${cards}</div>
${affiliatePresent ? `<p class="ftc-disclosure">${FTC_DISCLOSURE}</p>` : ''}
`;
    return this.shell(input.config, 'Books', content, affiliatePresent);
  }

  private buildBookPage(book: WebsiteBook, input: WebsiteBuildInput): string {
    const affiliatePresent = !!book.buyLinks?.some(l => l.isAffiliate);
    const buyLinks = (book.buyLinks || []).map(l =>
      `<a href="${this.esc(l.url)}" class="buy-link" rel="${l.isAffiliate ? 'sponsored nofollow' : ''} noopener" target="_blank">${this.esc(l.label)}</a>`
    ).join(' · ');

    const content = `
<article class="book-page">
  ${book.coverImagePath ? `<img src="${this.esc(book.coverImagePath)}" alt="Cover of ${this.esc(book.title)}" class="cover" />` : ''}
  <div class="meta">
    <h1>${this.esc(book.title)}</h1>
    ${book.subtitle ? `<p class="subtitle">${this.esc(book.subtitle)}</p>` : ''}
    ${book.seriesName ? `<p class="series">${this.esc(book.seriesName)}${book.seriesNumber ? ` · Book ${book.seriesNumber}` : ''}</p>` : ''}
    ${book.releaseDate ? `<p class="release-date">Released: ${this.esc(book.releaseDate)}</p>` : ''}
    ${book.formats ? `<p class="formats">Formats: ${book.formats.join(' · ')}</p>` : ''}
  </div>
  <div class="blurb">${book.blurb}</div>
  ${buyLinks ? `<div class="buy-links">${buyLinks}</div>` : ''}
  ${affiliatePresent ? `<p class="ftc-disclosure">${FTC_DISCLOSURE}</p>` : ''}
</article>
<p><a href="../books.html">← All books</a></p>
`;
    return this.shell(input.config, book.title, content, affiliatePresent);
  }

  private buildBlogIndex(input: WebsiteBuildInput): string {
    const cards = input.blogPosts
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(p => `
<article class="post-card">
  <h3><a href="${this.esc(this.sanitizeSlug(p.slug || p.title))}.html">${this.esc(p.title)}</a></h3>
  <time>${this.esc(p.date.split('T')[0])}</time>
  ${p.excerpt ? `<p>${this.esc(p.excerpt)}</p>` : ''}
  ${p.tags?.length ? `<div class="tags">${p.tags.map(t => `<span class="tag">${this.esc(t)}</span>`).join('')}</div>` : ''}
</article>`).join('\n');

    return this.shell(input.config, 'Blog', `<h1>Blog</h1><div class="post-list">${cards || '<p>No posts yet.</p>'}</div>`, false);
  }

  private buildBlogPost(post: WebsiteBlogPost, input: WebsiteBuildInput): string {
    const content = `
<article class="blog-post">
  <h1>${this.esc(post.title)}</h1>
  <time>${this.esc(post.date.split('T')[0])}</time>
  ${post.author ? `<p class="byline">by ${this.esc(post.author)}</p>` : ''}
  <div class="body">${post.bodyHTML}</div>
  ${post.tags?.length ? `<div class="tags">${post.tags.map(t => `<span class="tag">${this.esc(t)}</span>`).join('')}</div>` : ''}
  ${post.includesAffiliateLinks ? `<p class="ftc-disclosure">${FTC_DISCLOSURE}</p>` : ''}
</article>
<p><a href="index.html">← All posts</a></p>
`;
    return this.shell(input.config, post.title, content, !!post.includesAffiliateLinks);
  }

  private buildAboutPage(input: WebsiteBuildInput): string {
    const body = input.aboutHTML || `<p>${this.esc(input.config.authorName)} is the author behind ${this.esc(input.config.siteName)}.</p>`;
    return this.shell(input.config, 'About', `<h1>About</h1>${body}`, false);
  }

  private buildContactPage(input: WebsiteBuildInput): string {
    const body = input.contactHTML ?? `<p>For press, rights, and other enquiries, get in touch:</p>
<p><a href="mailto:contact@${this.esc(this.domainFromBaseUrl(input.config.baseUrl))}">contact@${this.esc(this.domainFromBaseUrl(input.config.baseUrl))}</a></p>
<p class="small">Email only. No form handler is wired up on this static site by default.</p>`;
    return this.shell(input.config, 'Contact', `<h1>Contact</h1>${body}`, false);
  }

  private buildRSS(input: WebsiteBuildInput): string {
    const url = input.config.baseUrl.replace(/\/$/, '');
    const items = input.blogPosts
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20)
      .map(p => `<item>
  <title>${this.esc(p.title)}</title>
  <link>${url}/blog/${this.esc(this.sanitizeSlug(p.slug || p.title))}.html</link>
  <pubDate>${new Date(p.date).toUTCString()}</pubDate>
  <description>${this.esc(p.excerpt || '')}</description>
  <guid>${url}/blog/${this.esc(this.sanitizeSlug(p.slug || p.title))}.html</guid>
</item>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${this.esc(input.config.siteName)}</title>
<link>${url}</link>
<description>${this.esc(input.config.tagline || input.config.siteName)}</description>
${items}
</channel>
</rss>`;
  }

  private buildSitemap(input: WebsiteBuildInput, pages: string[]): string {
    const url = input.config.baseUrl.replace(/\/$/, '');
    const entries = pages
      .filter(p => p.endsWith('.html'))
      .map(p => `<url><loc>${url}/${p}</loc></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
  }

  // ── Shell / theme ──

  private shell(config: WebsiteSiteConfig, pageTitle: string, content: string, hasAffiliateLinks: boolean): string {
    const nav = `
<nav class="main-nav" aria-label="Primary">
  <a href="index.html" class="brand">${this.esc(config.siteName)}</a>
  <ul>
    <li><a href="books.html">Books</a></li>
    <li><a href="blog/index.html">Blog</a></li>
    <li><a href="about.html">About</a></li>
    <li><a href="contact.html">Contact</a></li>
  </ul>
</nav>`;

    const socialLinks = config.social ? Object.entries(config.social).filter(([_, v]) => !!v)
      .map(([k, v]) => `<a href="${this.esc(v!)}" rel="noopener" target="_blank">${this.esc(k)}</a>`).join(' · ') : '';

    const footer = `
<footer class="site-footer">
  <p>&copy; ${new Date().getFullYear()} ${this.esc(config.authorName)}. All rights reserved.</p>
  ${socialLinks ? `<p class="social">${socialLinks}</p>` : ''}
  ${hasAffiliateLinks ? `<p class="ftc-footer"><small>Affiliate disclosure above applies to links on this page.</small></p>` : ''}
</footer>`;

    const analyticsBlock = config.analyticsSnippet
      ? `<!-- Analytics (author-provided) -->\n${config.analyticsSnippet}`
      : '<!-- Analytics snippet (not configured) -->';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this.esc(pageTitle)} — ${this.esc(config.siteName)}</title>
${config.tagline ? `<meta name="description" content="${this.esc(config.tagline)}">` : ''}
<meta name="generator" content="AuthorAgent">
<link rel="stylesheet" href="${pageTitle === 'Home' || pageTitle === 'About' || pageTitle === 'Books' || pageTitle === 'Contact' ? 'styles.css' : '../styles.css'}">
<link rel="alternate" type="application/rss+xml" title="${this.esc(config.siteName)} RSS" href="${pageTitle === 'Home' || pageTitle === 'About' || pageTitle === 'Books' || pageTitle === 'Contact' ? 'feed.xml' : '../feed.xml'}">
</head>
<body>
${nav}
<main>
${content}
</main>
${footer}
${analyticsBlock}
</body>
</html>`;
  }

  private buildCSS(config: WebsiteSiteConfig): string {
    const primary = config.primaryColor || '#2b4a6b';
    const font = config.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    return `/* AuthorAgent-generated theme */
:root { --primary: ${primary}; --text: #1a1a1a; --muted: #666; --bg: #fafafa; --card: #fff; --border: #e5e5e5; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ${font}; color: var(--text); background: var(--bg); line-height: 1.6; }
main { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { line-height: 1.25; }
.main-nav { background: var(--card); border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.main-nav .brand { font-weight: 700; color: var(--primary); font-size: 1.25rem; }
.main-nav ul { list-style: none; margin: 0; padding: 0; display: flex; gap: 1.5rem; }
.hero { text-align: center; padding: 3rem 0; }
.hero h1 { font-size: 2.5rem; color: var(--primary); margin: 0 0 0.5rem; }
.tagline { font-size: 1.2rem; color: var(--muted); }
.cta-block { display: flex; gap: 1rem; justify-content: center; padding: 2rem 0; flex-wrap: wrap; }
.btn, .cta { display: inline-block; padding: 0.75rem 1.5rem; background: var(--primary); color: #fff; border-radius: 6px; font-weight: 500; }
.btn:hover, .cta:hover { opacity: 0.9; text-decoration: none; }
.book-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.5rem; }
.book-card { background: var(--card); padding: 1rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.book-card img, .featured-book img { width: 100%; height: auto; border-radius: 4px; }
.book-card h3 { margin: 0.5rem 0 0.25rem; font-size: 1.1rem; }
.book-card .series, .book-card .genre { color: var(--muted); font-size: 0.875rem; margin: 0.25rem 0; }
.book-page { display: grid; grid-template-columns: 300px 1fr; gap: 2rem; }
.book-page .cover { width: 100%; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
.book-page .meta h1 { margin: 0 0 0.25rem; }
.buy-links { margin: 1.5rem 0; padding: 1rem; background: var(--card); border-radius: 6px; }
.buy-link { font-weight: 500; }
.post-card { background: var(--card); padding: 1.25rem; border-radius: 8px; margin-bottom: 1rem; }
.post-card h3 { margin: 0 0 0.25rem; }
.post-card time { color: var(--muted); font-size: 0.875rem; }
.tag { display: inline-block; background: #eef; color: var(--primary); padding: 0.1rem 0.5rem; border-radius: 12px; font-size: 0.75rem; margin-right: 0.25rem; }
.blog-post .body { font-size: 1.05rem; }
.blog-post .body p { margin-bottom: 1rem; }
.ftc-disclosure { margin: 1.5rem 0; padding: 0.75rem 1rem; background: #fff8e1; border-left: 4px solid #f0c420; font-size: 0.875rem; border-radius: 4px; }
.site-footer { text-align: center; padding: 2rem 1rem; color: var(--muted); border-top: 1px solid var(--border); margin-top: 4rem; }
.site-footer .social { font-size: 0.875rem; }
.ftc-footer { margin-top: 0.5rem; }
@media (max-width: 640px) {
  .book-page { grid-template-columns: 1fr; }
  .main-nav { flex-direction: column; gap: 0.75rem; }
}`;
  }

  private buildDeployReadme(config: WebsiteSiteConfig, outputDir: string): string {
    return `# Deploy ${config.siteName}

AuthorAgent generated this static site at:
\`${outputDir}\`

## Deployment options

### Netlify (drag and drop, free tier)
1. Go to https://app.netlify.com/drop
2. Drag this folder onto the drop zone
3. Netlify assigns a \`*.netlify.app\` URL; add your custom domain in site settings

### Vercel
\`\`\`sh
cd "${outputDir}"
npx vercel
\`\`\`

### Cloudflare Pages
1. Push this folder to a new GitHub repo
2. Connect the repo at https://dash.cloudflare.com/pages
3. Build command: (leave empty) | Output dir: \`/\`

### GitHub Pages
1. Create a new repo, push this folder's contents to it
2. Settings → Pages → Deploy from a branch → \`main\` → \`/\`

### S3 + CloudFront
Upload the folder contents to an S3 bucket configured for static website hosting, point CloudFront at it.

## Things AuthorAgent cannot do for you

- Buy or configure the domain name.
- Set up HTTPS certificates (your host will do this automatically on most modern platforms).
- Sign up for an ESP (ConvertKit / MailerLite / Beehiiv). Once you do, paste the ESP's embed code into the \`newsletterEmbedHTML\` config field and rebuild.
- Configure analytics. Once you have a provider (Plausible, Fathom, Google Analytics, etc.), paste their snippet into the \`analyticsSnippet\` config field.
- Verify you have rights to every affiliate program you link to. Amazon Associates in particular has geographic restrictions.

## Regeneration

Edit the site config in AuthorAgent and re-run the build. The output directory is overwritten each build. Back up any hand-edits to \`book/*.html\` or \`blog/*.html\` before regenerating — they will be lost.

## Disclosures

AuthorAgent automatically adds the FTC affiliate-link disclosure to any page whose content includes an affiliate link. Do not remove it.
`;
  }

  // ── Helpers ──

  private esc(s: string | undefined): string {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private sanitizeSlug(s: string): string {
    return String(s || 'untitled').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'untitled';
  }

  private domainFromBaseUrl(baseUrl: string): string {
    try { return new URL(baseUrl).hostname; }
    catch { return 'example.com'; }
  }

  /** List all sites built in the workspace. */
  async listSites(): Promise<Array<{ slug: string; path: string; hasIndex: boolean }>> {
    const root = join(this.workspaceDir, 'website');
    if (!existsSync(root)) return [];
    const entries = await readdir(root);
    return entries
      .filter(e => !e.startsWith('.'))
      .map(slug => ({
        slug,
        path: join(root, slug),
        hasIndex: existsSync(join(root, slug, 'index.html')),
      }));
  }
}
