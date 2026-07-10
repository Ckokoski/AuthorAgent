/**
 * AuthorAgent Track Changes
 *
 * Parses .docx files with Word Review track-changes markup:
 *   <w:ins>       inserted text
 *   <w:del>       deleted text (text wrapped in <w:delText>)
 *   <w:rPrChange> formatting change
 *   <w:comments>  reviewer comments
 *
 * Produces a structured diff the dashboard can render, and can also apply
 * user-selected accept/reject decisions to generate a clean Markdown output
 * suitable for re-importing into AuthorAgent.
 *
 * Uses the already-bundled `adm-zip` dependency (no new deps needed).
 */

import AdmZip from 'adm-zip';

export type ChangeType = 'insert' | 'delete' | 'formatting' | 'comment';
export type ChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface TrackedChange {
  id: string;                   // Stable within a document
  type: ChangeType;
  author: string;
  date: string;                 // ISO
  text: string;                 // Inserted / deleted text
  paragraphIndex: number;       // 0-based position in the document
  context?: string;             // Surrounding text (~80 chars each side)
  commentRef?: string;          // Links a comment to the paragraph it's on
  status: ChangeStatus;
}

export interface TrackChangesReport {
  documentPath?: string;
  authors: string[];
  totalChanges: number;
  byType: Record<ChangeType, number>;
  changes: TrackedChange[];
  paragraphCount: number;
}

export class TrackChangesService {
  /**
   * Parse a .docx buffer and return a structured diff.
   */
  parseDocx(buffer: Buffer): TrackChangesReport {
    const zip = new AdmZip(buffer);
    const documentEntry = zip.getEntry('word/document.xml');
    if (!documentEntry) {
      throw new Error('Invalid .docx: word/document.xml not found');
    }
    const xml = documentEntry.getData().toString('utf-8');

    const commentsEntry = zip.getEntry('word/comments.xml');
    const commentsXml = commentsEntry?.getData().toString('utf-8');

    const changes: TrackedChange[] = [];
    const authors = new Set<string>();
    let paragraphCount = 0;

    // Iterate over paragraphs: <w:p>...</w:p>
    const paraMatches = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    paragraphCount = paraMatches.length;

    paraMatches.forEach((paraXml, paraIdx) => {
      // Paragraph text (for context strings).
      const paraText = this.extractParagraphText(paraXml);

      // Inserts
      const insRe = /<w:ins\b[^>]*?(?:w:author="([^"]*)")?[^>]*?(?:w:date="([^"]*)")?[^>]*>([\s\S]*?)<\/w:ins>/g;
      let m: RegExpExecArray | null;
      while ((m = insRe.exec(paraXml)) !== null) {
        const author = m[1] || 'Unknown';
        const date = m[2] || '';
        const insertedText = this.extractRunsText(m[3]);
        if (!insertedText) continue;
        authors.add(author);
        changes.push({
          id: `ins-${paraIdx}-${changes.length}`,
          type: 'insert',
          author,
          date,
          text: insertedText,
          paragraphIndex: paraIdx,
          context: paraText.slice(0, 160),
          status: 'pending',
        });
      }

      // Deletes (<w:del>…<w:delText>…</w:delText></w:del>)
      const delRe = /<w:del\b[^>]*?(?:w:author="([^"]*)")?[^>]*?(?:w:date="([^"]*)")?[^>]*>([\s\S]*?)<\/w:del>/g;
      while ((m = delRe.exec(paraXml)) !== null) {
        const author = m[1] || 'Unknown';
        const date = m[2] || '';
        const deletedText = this.extractDelText(m[3]);
        if (!deletedText) continue;
        authors.add(author);
        changes.push({
          id: `del-${paraIdx}-${changes.length}`,
          type: 'delete',
          author,
          date,
          text: deletedText,
          paragraphIndex: paraIdx,
          context: paraText.slice(0, 160),
          status: 'pending',
        });
      }

      // Formatting changes (<w:rPrChange>)
      const fmtRe = /<w:rPrChange\b[^>]*?(?:w:author="([^"]*)")?[^>]*?(?:w:date="([^"]*)")?[^>]*\/>/g;
      while ((m = fmtRe.exec(paraXml)) !== null) {
        const author = m[1] || 'Unknown';
        const date = m[2] || '';
        authors.add(author);
        changes.push({
          id: `fmt-${paraIdx}-${changes.length}`,
          type: 'formatting',
          author,
          date,
          text: '(formatting change)',
          paragraphIndex: paraIdx,
          context: paraText.slice(0, 160),
          status: 'pending',
        });
      }
    });

    // Comments
    if (commentsXml) {
      const commentRe = /<w:comment\b[^>]*?w:id="([^"]*)"[^>]*?(?:w:author="([^"]*)")?[^>]*?(?:w:date="([^"]*)")?[^>]*>([\s\S]*?)<\/w:comment>/g;
      let m: RegExpExecArray | null;
      while ((m = commentRe.exec(commentsXml)) !== null) {
        const author = m[2] || 'Unknown';
        const date = m[3] || '';
        const commentText = this.extractRunsText(m[4]);
        if (!commentText) continue;
        authors.add(author);
        changes.push({
          id: `comment-${m[1]}`,
          type: 'comment',
          author,
          date,
          text: commentText,
          paragraphIndex: -1,
          commentRef: m[1],
          status: 'pending',
        });
      }
    }

    const byType: Record<ChangeType, number> = { insert: 0, delete: 0, formatting: 0, comment: 0 };
    for (const c of changes) byType[c.type]++;

    return {
      authors: Array.from(authors),
      totalChanges: changes.length,
      byType,
      changes,
      paragraphCount,
    };
  }

  /**
   * Apply a set of accept/reject decisions to produce clean Markdown.
   * Changes marked "accepted" are applied; "rejected" revert to the original.
   * Pending changes are treated as rejected (safer default).
   */
  applyDecisions(buffer: Buffer, decisions: Map<string, ChangeStatus>): string {
    const zip = new AdmZip(buffer);
    const documentEntry = zip.getEntry('word/document.xml');
    if (!documentEntry) throw new Error('Invalid .docx: word/document.xml not found');
    const xml = documentEntry.getData().toString('utf-8');

    // Re-parse to get IDs in the same order we generated them.
    const report = this.parseDocx(buffer);

    // Build paragraph-level text with accepted changes applied.
    const paraMatches = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    const outputParagraphs: string[] = [];

    paraMatches.forEach((paraXml, paraIdx) => {
      // Start with the base paragraph text (non-ins, non-del runs).
      let processedXml = paraXml;

      // Process inserts: include if accepted, drop if rejected.
      let insIdx = 0;
      processedXml = processedXml.replace(
        /<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g,
        (_, inner) => {
          const changeId = `ins-${paraIdx}-${this.findChangeIndex(report.changes, 'insert', paraIdx, insIdx++)}`;
          const decision = decisions.get(changeId) || 'pending';
          if (decision === 'accepted') return inner;
          return ''; // rejected or pending → drop
        }
      );

      // Process deletes: drop if accepted (deletion confirmed), keep if rejected.
      let delIdx = 0;
      processedXml = processedXml.replace(
        /<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g,
        (_, inner) => {
          const changeId = `del-${paraIdx}-${this.findChangeIndex(report.changes, 'delete', paraIdx, delIdx++)}`;
          const decision = decisions.get(changeId) || 'pending';
          if (decision === 'accepted') return ''; // deletion confirmed → drop
          // rejected or pending → keep the deleted text (extract from <w:delText>)
          return inner.replace(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g, '$1');
        }
      );

      // Strip all remaining tags to get plain text.
      const text = this.extractParagraphText(processedXml);
      if (text.trim()) outputParagraphs.push(text);
    });

    return outputParagraphs.join('\n\n');
  }

  /** Find the nth change of a given type at a paragraph. */
  private findChangeIndex(
    allChanges: TrackedChange[],
    type: ChangeType,
    paraIdx: number,
    occurrence: number,
  ): number {
    let count = 0;
    for (let i = 0; i < allChanges.length; i++) {
      const c = allChanges[i];
      if (c.type === type && c.paragraphIndex === paraIdx) {
        if (count === occurrence) return i;
        count++;
      }
    }
    return -1;
  }

  /** Extract run text (<w:t>) from any XML fragment. */
  private extractRunsText(xml: string): string {
    const parts: string[] = [];
    const re = /<w:t\b[^>]*>([^<]*)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      parts.push(m[1]);
    }
    return parts.join('').trim();
  }

  /** Extract <w:delText> content from a delete fragment. */
  private extractDelText(xml: string): string {
    const parts: string[] = [];
    const re = /<w:delText\b[^>]*>([^<]*)<\/w:delText>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      parts.push(m[1]);
    }
    return parts.join('').trim();
  }

  /** Plain text of a paragraph (strips all tags). */
  private extractParagraphText(paraXml: string): string {
    // Remove delText so only the final visible text remains (unless we kept
    // deletes at the caller; this helper is used for context extraction).
    const withoutDeletes = paraXml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
    return this.extractRunsText(withoutDeletes);
  }
}
