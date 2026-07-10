/**
 * AuthorAgent KDP Exporter
 *
 * Converts a plain-text or lightly-formatted blurb into the exact HTML subset
 * that Amazon KDP accepts in the Book Description field, plus a 400-char
 * "book preview" variant and a plain-text fallback.
 *
 * KDP allows: <b>, <i>, <u>, <br>, <p>, <ul>, <li>, <ol>, <em>, <strong>,
 *             <h4>, <h5>, <h6>, <s>, <sub>, <sup>.
 * Limit: 4000 characters (including tags). Practical sweet spot: ~1800-2200.
 */

const KDP_ALLOWED_TAGS = new Set([
  'b', 'i', 'u', 'br', 'p', 'ul', 'li', 'ol',
  'em', 'strong', 'h4', 'h5', 'h6', 's', 'sub', 'sup',
]);

const KDP_MAX_CHARS = 4000;
const KDP_PREVIEW_MAX_CHARS = 400;

export interface BlurbExport {
  html: string;                 // Sanitized HTML ready to paste into KDP
  plainText: string;            // Plain-text fallback (no tags)
  preview: string;              // 400-char preview for Amazon "About the book"
  charCount: number;            // HTML length (KDP's metric)
  plainCharCount: number;       // Plain text length
  warnings: string[];           // Any issues we couldn't auto-fix
}

export class KDPExporter {
  /**
   * Convert a markdown-ish blurb into KDP-compliant HTML plus variants.
   */
  exportBlurb(input: string): BlurbExport {
    const warnings: string[] = [];
    let html = this.markdownToKdpHtml(input);
    html = this.stripDisallowedTags(html, warnings);
    html = this.normalizeWhitespace(html);

    if (html.length > KDP_MAX_CHARS) {
      warnings.push(
        `HTML length ${html.length} exceeds KDP's ${KDP_MAX_CHARS}-char limit. Trim the blurb or remove formatting.`
      );
    }

    const plainText = this.stripTags(html);
    const preview = this.makePreview(plainText);

    return {
      html,
      plainText,
      preview,
      charCount: html.length,
      plainCharCount: plainText.length,
      warnings,
    };
  }

  /** Very small markdown → KDP-HTML converter (bold, italic, paragraphs, lists, breaks). */
  private markdownToKdpHtml(input: string): string {
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let inList: 'ul' | 'ol' | null = null;

    const closeList = () => {
      if (inList) {
        out.push(`</${inList}>`);
        inList = null;
      }
    };

    const inlineFormat = (s: string): string => {
      // **bold** → <b>
      s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      // *italic* or _italic_ → <i>  (but not **)
      s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
      s = s.replace(/\b_([^_\n]+)_\b/g, '<i>$1</i>');
      return s;
    };

    const paragraphBuffer: string[] = [];
    const flushParagraph = () => {
      if (paragraphBuffer.length > 0) {
        const text = inlineFormat(paragraphBuffer.join(' ').trim());
        if (text) out.push(`<p>${text}</p>`);
        paragraphBuffer.length = 0;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushParagraph();
        closeList();
        continue;
      }
      // Bullet list
      const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
      if (bulletMatch) {
        flushParagraph();
        if (inList !== 'ul') {
          closeList();
          out.push('<ul>');
          inList = 'ul';
        }
        out.push(`<li>${inlineFormat(bulletMatch[1])}</li>`);
        continue;
      }
      // Numbered list
      const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
      if (numberedMatch) {
        flushParagraph();
        if (inList !== 'ol') {
          closeList();
          out.push('<ol>');
          inList = 'ol';
        }
        out.push(`<li>${inlineFormat(numberedMatch[1])}</li>`);
        continue;
      }
      // Regular line — accumulate into paragraph
      closeList();
      paragraphBuffer.push(line);
    }

    flushParagraph();
    closeList();

    return out.join('\n');
  }

  /** Remove any HTML tag that KDP doesn't accept. */
  private stripDisallowedTags(html: string, warnings: string[]): string {
    const disallowed = new Set<string>();
    const cleaned = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag) => {
      const lower = tag.toLowerCase();
      if (KDP_ALLOWED_TAGS.has(lower)) return match;
      disallowed.add(lower);
      return '';
    });
    if (disallowed.size > 0) {
      warnings.push(`Stripped disallowed tags: ${Array.from(disallowed).join(', ')}`);
    }
    return cleaned;
  }

  /** Collapse excessive whitespace but preserve intentional structure. */
  private normalizeWhitespace(html: string): string {
    return html
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Strip all HTML tags for the plain-text fallback. */
  private stripTags(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Build the 400-char Amazon "About the book" preview from plain text. */
  private makePreview(plainText: string): string {
    const firstPara = plainText.split(/\n\s*\n/)[0] || plainText;
    if (firstPara.length <= KDP_PREVIEW_MAX_CHARS) return firstPara.trim();
    // Truncate at a sentence boundary within the limit.
    const truncated = firstPara.substring(0, KDP_PREVIEW_MAX_CHARS);
    const lastSentence = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf('? ')
    );
    if (lastSentence > KDP_PREVIEW_MAX_CHARS * 0.6) {
      return truncated.substring(0, lastSentence + 1).trim();
    }
    // Fall back to word boundary.
    const lastSpace = truncated.lastIndexOf(' ');
    return truncated.substring(0, lastSpace > 0 ? lastSpace : KDP_PREVIEW_MAX_CHARS).trim() + '…';
  }
}
