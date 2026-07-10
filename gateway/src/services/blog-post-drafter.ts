/**
 * AuthorAgent Blog Post Drafter
 *
 * Drafts blog posts from project artifacts. Authors who don't blog regularly
 * tend not to update their websites at all — books ship, nothing goes up,
 * the site rots. This service generates 4 specific post types so an author
 * can spin up a new post in one prompt without staring at a blank page.
 *
 * IMPORTANT: This drafts content only. The author still:
 *   - Reviews the draft (always — drafts go to "pending_review")
 *   - Edits / accepts / rejects in the dashboard
 *   - Decides when it gets published to the live site
 *
 * Four post types, each with a distinct prompt that pulls different project
 * artifacts:
 *
 *   release_announcement — Just shipped a book. Pulls title, blurb, comp
 *                           titles, buy links. Output: ~600 word announcement.
 *   behind_the_scenes    — Process post. Pulls user-model + chapter
 *                           summaries + craft-critic output. Output:
 *                           ~800 word "how I wrote this" post.
 *   excerpt              — Reader bait. Pulls a strong scene from the
 *                           manuscript and frames it (lead-in tagline +
 *                           the excerpt + tease + buy link). ~700 words.
 *   teaser               — Coming-soon post. Pulls premise + comps + cover.
 *                           Output: ~400 word teaser.
 *
 * What this service does NOT do:
 *   - Auto-publish to the live site (drafts go to review queue)
 *   - Generate SEO meta tags / structured data (the WebsiteBuilder already
 *     emits sitemap / RSS / OG tags from the site config)
 *   - Schedule posts (a future cron handler can do this)
 */

import type { WebsiteBlogPost } from './website-builder.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type BlogPostType =
  | 'release_announcement'
  | 'behind_the_scenes'
  | 'excerpt'
  | 'teaser';

export interface BlogDraftRequest {
  /** Which post type to draft. */
  postType: BlogPostType;
  projectId: string;
  /** Optional: override the AI's choice of excerpt source by passing a
   *  specific scene/chapter text. Used by the excerpt post type. */
  excerptText?: string;
  /** Optional steering — author-provided angle. */
  authorAngle?: string;
  /** Provider override; otherwise the active default is used. */
  preferredProvider?: string;
}

export interface BlogDraftResult {
  /** The draft, formatted as a WebsiteBlogPost ready to add to a site. */
  post: WebsiteBlogPost;
  /** What kind of post this is (so the dashboard can group review queues). */
  postType: BlogPostType;
  /** The system prompt used (for transparency / re-runs). */
  systemPromptUsed: string;
  /** Estimated AI cost in USD. */
  estimatedCost: number;
  /** Provider that produced the draft. */
  provider: string;
}

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed?: number; estimatedCost?: number; provider?: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

// ═══════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════

const RELEASE_ANNOUNCEMENT_PROMPT = `You are drafting a "new release" blog post for an author's website. The post should be 500-700 words, conversational and warm (NOT marketing-flat), and end with clear buy links.

Structure:
  1. A real opening line — not "I'm excited to announce..." (overused). Try a sentence that captures what the book is actually about, or a moment from writing it.
  2. The pitch — what the book is, who it's for, in 2-3 paragraphs. Use voice; don't write a back-cover blurb.
  3. The story behind it — 1-2 paragraphs of personal context. Why now, what surprised the author, what they hope readers feel.
  4. Buy links / CTA — clear, action-oriented.

Output the post as plain Markdown with an H1 title. NO HTML. NO frontmatter. NO meta-commentary.`;

const BEHIND_THE_SCENES_PROMPT = `You are drafting a "behind the scenes" blog post about how an author wrote their recent book. The post should be 700-900 words.

Authors blog these posts to build reader connection — readers want to know the real process, not a sanitized version. Be specific. Include actual moments from the writing process (drafted scenes the author cut, character decisions that surprised them, research rabbit holes).

Structure:
  1. The hook — a specific concrete moment from writing this book. Not "I worked hard." Something like "I wrote chapter 7 four times and threw out three of them."
  2. The real process — 3-4 paragraphs covering how the book actually came together. Use the project artifacts (chapter summaries, craft-critic flags, user-model patterns) to ground specifics.
  3. What changed during writing — what the author discovered, what they thought they were writing vs what it became.
  4. A reader-facing close — what the author hopes the reader takes from the book.

Output as plain Markdown. Voice is the author's voice (use the user-model context provided). NO HTML. NO frontmatter. NO meta-commentary.`;

const EXCERPT_PROMPT = `You are drafting an "excerpt" blog post. The post features a scene from the book (provided) with a brief lead-in and a tease/CTA at the end. Total length: 600-900 words including the excerpt.

Structure:
  1. Lead-in (2-3 paragraphs): set the scene without spoiling. Tell the reader what they're about to read and why it matters in the book — but don't reveal the outcome.
  2. The excerpt itself: ALWAYS preserve the author's prose verbatim. Do NOT rewrite it. Do NOT summarize it. Use a Markdown blockquote.
  3. The tease (1-2 paragraphs): leave the reader wanting more. Hint at consequence; don't spoil.
  4. CTA: buy links.

Output as plain Markdown. NO HTML. NO frontmatter. NO meta-commentary outside the post itself.`;

const TEASER_PROMPT = `You are drafting a "coming soon" teaser post for a forthcoming book. The post should be 350-500 words. Build anticipation; don't oversell.

Structure:
  1. A real opening — not "I'm excited to share..." but a sentence that captures the book's mood or premise.
  2. The pitch — what the book is, in 2-3 short paragraphs. Use the premise + comp titles. Be confident; readers can tell when authors aren't.
  3. What to expect — release timing if known, where to pre-order if open, where to get notified.
  4. CTA: subscribe to the newsletter, follow on social, etc. (use the site's actual links).

Output as plain Markdown. NO HTML. NO frontmatter. NO meta-commentary.`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class BlogPostDrafterService {
  /**
   * Draft a blog post from project artifacts. Caller passes the project +
   * optional supplemental fields (excerpt text, author angle), this service
   * builds the appropriate prompt and returns a ready-for-review draft.
   */
  async draft(
    request: BlogDraftRequest,
    project: {
      id: string;
      title: string;
      description: string;
      type: string;
      genre?: string;
      personaId?: string;
      authorName?: string;
      buyLinks?: Array<{ label: string; url: string; isAffiliate?: boolean }>;
      comps?: string[];
      releaseDate?: string;
    },
    artifacts: {
      /** Optional — chapter summaries from ContextEngine for behind-the-scenes posts. */
      chapterSummaries?: Array<{ chapterNumber: number; summary: string }>;
      /** Optional — Style Clone signature so the AI can match author voice. */
      voiceSignature?: string;
      /** Optional — user-model narrative (when behind-the-scenes is requested). */
      userModelNarrative?: string;
    },
    deps: { aiComplete: AICompleteFn; aiSelectProvider: AISelectProviderFn },
  ): Promise<BlogDraftResult> {
    const systemPrompt = this.getSystemPrompt(request.postType);
    const userMessage = this.buildUserMessage(request, project, artifacts);

    const provider = deps.aiSelectProvider('creative_writing');
    const response = await deps.aiComplete({
      provider: request.preferredProvider || provider.id,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 2500,
      temperature: 0.7,
    });

    const text = (response.text || '').trim();
    if (!text) throw new Error('AI returned empty draft');

    // Parse the title from the first H1 line, fall back to a default.
    const titleMatch = text.match(/^#\s+(.+?)$/m);
    const title = titleMatch ? titleMatch[1].trim() : this.defaultTitle(request.postType, project.title);

    // Strip the H1 from the body — the website builder renders it from the
    // post's title field separately.
    const body = text.replace(/^#\s+.+?\n+/, '').trim();

    const post: WebsiteBlogPost = {
      slug: '', // will be filled by website-sites.addBlogPost via sanitizeSlug
      title,
      date: new Date().toISOString(),
      author: project.authorName,
      excerpt: this.firstParagraphPlain(body, 200),
      bodyHTML: this.markdownToBasicHTML(body),
      tags: this.tagsForPostType(request.postType, project.genre),
      includesAffiliateLinks: !!project.buyLinks?.some(l => l.isAffiliate),
    };

    return {
      post,
      postType: request.postType,
      systemPromptUsed: systemPrompt,
      estimatedCost: response.estimatedCost ?? 0,
      provider: response.provider ?? provider.id,
    };
  }

  // ── Prompt routing ──

  private getSystemPrompt(postType: BlogPostType): string {
    switch (postType) {
      case 'release_announcement': return RELEASE_ANNOUNCEMENT_PROMPT;
      case 'behind_the_scenes':    return BEHIND_THE_SCENES_PROMPT;
      case 'excerpt':              return EXCERPT_PROMPT;
      case 'teaser':               return TEASER_PROMPT;
    }
  }

  private buildUserMessage(
    request: BlogDraftRequest,
    project: {
      title: string;
      description: string;
      genre?: string;
      authorName?: string;
      buyLinks?: Array<{ label: string; url: string; isAffiliate?: boolean }>;
      comps?: string[];
      releaseDate?: string;
    },
    artifacts: {
      chapterSummaries?: Array<{ chapterNumber: number; summary: string }>;
      voiceSignature?: string;
      userModelNarrative?: string;
    },
  ): string {
    const lines: string[] = [];
    lines.push(`Book title: ${project.title}`);
    if (project.authorName) lines.push(`Author: ${project.authorName}`);
    if (project.genre) lines.push(`Genre: ${project.genre}`);
    if (project.releaseDate) lines.push(`Release date: ${project.releaseDate}`);
    lines.push(`Premise / blurb: ${project.description.slice(0, 600)}`);

    if (project.comps && project.comps.length > 0) {
      lines.push(`\nComparable titles: ${project.comps.slice(0, 5).join('; ')}`);
    }

    if (request.authorAngle) {
      lines.push(`\nAuthor's angle for this post: ${request.authorAngle}`);
    }

    if (artifacts.voiceSignature) {
      lines.push(`\nAuthor voice signature: ${artifacts.voiceSignature}`);
    }

    if (artifacts.userModelNarrative && request.postType === 'behind_the_scenes') {
      lines.push(`\nAuthor profile (use for voice + framing — never quote verbatim):\n${artifacts.userModelNarrative.slice(0, 800)}`);
    }

    if (artifacts.chapterSummaries && artifacts.chapterSummaries.length > 0 &&
        (request.postType === 'behind_the_scenes' || request.postType === 'release_announcement')) {
      lines.push(`\nChapter-level outline (for grounding the post in actual story moments — DO NOT spoil):\n` +
        artifacts.chapterSummaries.slice(0, 8).map(c => `  Ch ${c.chapterNumber}: ${c.summary.slice(0, 200)}`).join('\n'));
    }

    if (request.postType === 'excerpt') {
      const excerpt = request.excerptText ? request.excerptText.slice(0, 4000)
        : '(No excerpt provided — pick a strong opening from a chapter you know is solid; or use the project description if no chapters are available)';
      lines.push(`\nScene to feature as the excerpt (PRESERVE PROSE VERBATIM — quote in a Markdown blockquote):\n\n${excerpt}`);
    }

    if (project.buyLinks && project.buyLinks.length > 0) {
      lines.push(`\nBuy links to include in CTA:\n` + project.buyLinks.slice(0, 6).map(l => `  - [${l.label}](${l.url})`).join('\n'));
    }

    lines.push(`\nNow produce the ${request.postType} post. Output Markdown only — no frontmatter, no fences, no commentary.`);
    return lines.join('\n');
  }

  // ── Helpers ──

  private defaultTitle(postType: BlogPostType, bookTitle: string): string {
    switch (postType) {
      case 'release_announcement': return `${bookTitle} is here`;
      case 'behind_the_scenes':    return `Behind the writing of ${bookTitle}`;
      case 'excerpt':              return `An excerpt from ${bookTitle}`;
      case 'teaser':               return `Coming soon: ${bookTitle}`;
    }
  }

  private tagsForPostType(postType: BlogPostType, genre?: string): string[] {
    const base: Record<BlogPostType, string[]> = {
      release_announcement: ['new release', 'announcement'],
      behind_the_scenes:    ['process', 'craft', 'behind the scenes'],
      excerpt:              ['excerpt', 'preview'],
      teaser:               ['teaser', 'coming soon'],
    };
    const tags = [...base[postType]];
    if (genre) tags.push(genre.toLowerCase());
    return tags;
  }

  /** First non-blank paragraph, plain text, capped — used for excerpt field. */
  private firstParagraphPlain(body: string, max: number): string {
    const para = body.split(/\n\s*\n/).find(p => p.trim().length > 0) || '';
    const plain = para.replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim();
    return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
  }

  /**
   * Convert a small subset of Markdown into HTML good enough for the
   * website-builder's body output. Not a full Markdown parser — we
   * deliberately keep it tight: paragraphs, headings, bold/italic, links,
   * blockquotes, lists. Anything fancier (footnotes, tables) the author
   * can add by editing the post in the review step.
   */
  private markdownToBasicHTML(md: string): string {
    let html = md;
    // Escape HTML chars first (so the AI's text doesn't sneak in raw HTML).
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Headings (## and ###)
    html = html.replace(/^###\s+(.+?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+?)$/gm, '<h2>$1</h2>');
    // Blockquote
    html = html.replace(/^> ?(.+?)$/gm, '<blockquote>$1</blockquote>');
    // Collapse consecutive blockquote lines into one block
    html = html.replace(/(<\/blockquote>)\n(<blockquote>)/g, '<br>');
    // Lists (ul / ol)
    html = html.replace(/^(?:[*-] .+(?:\n[*-] .+)+)$/gm, m =>
      '<ul>' + m.split('\n').map(l => l.replace(/^[*-]\s+/, '')).map(l => `<li>${l}</li>`).join('') + '</ul>');
    html = html.replace(/^(?:\d+\. .+(?:\n\d+\. .+)+)$/gm, m =>
      '<ol>' + m.split('\n').map(l => l.replace(/^\d+\.\s+/, '')).map(l => `<li>${l}</li>`).join('') + '</ol>');
    // Bold
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_]+?)_/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
    // Paragraphs — wrap remaining text blocks
    html = html.split(/\n\s*\n+/).map(block => {
      const t = block.trim();
      if (!t) return '';
      if (/^<(?:h\d|ul|ol|blockquote|p)\b/i.test(t)) return t; // already block-level
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    return html;
  }
}
