/**
 * AuthorAgent DOCX Export Utility — V4
 * Professional KDP-ready interior formatting
 *
 * Supports: title page, copyright, dedication, TOC placeholder,
 * chapter headings with page breaks, scene breaks, back matter
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, PageBreak, TabStopType, TabStopPosition,
  SectionType,
} from 'docx';

export interface DocxExportOptions {
  title: string;
  author: string;
  content: string;       // Markdown content (chapters)
  subtitle?: string;
  dedication?: string;
  copyright?: string;    // Custom copyright text
  authorBio?: string;    // For back matter
  alsoBy?: string[];     // Other titles by this author
  newsletterCta?: string; // Newsletter call-to-action
  trimSize?: '5x8' | '5.5x8.5' | '6x9';
}

// KDP trim size margins (in twips, 1 inch = 1440 twips)
const TRIM_MARGINS: Record<string, { top: number; bottom: number; left: number; right: number }> = {
  '5x8': { top: 1080, bottom: 1080, left: 1080, right: 864 },        // 0.75" top/bottom, 0.75" left, 0.6" right
  '5.5x8.5': { top: 1080, bottom: 1080, left: 1080, right: 864 },
  '6x9': { top: 1152, bottom: 1152, left: 1152, right: 864 },        // 0.8" top/bottom, 0.8" left, 0.6" right
};

/**
 * Generate a professional KDP-ready DOCX buffer from markdown content.
 */
export async function generateDocxBuffer(options: DocxExportOptions): Promise<Buffer> {
  const { title, author, content, subtitle, dedication, copyright, authorBio, alsoBy, newsletterCta } = options;
  const margins = TRIM_MARGINS[options.trimSize || '5.5x8.5'];

  const sections: any[] = [];

  // ═══════════════════════════════════════
  // FRONT MATTER
  // ═══════════════════════════════════════

  // ── Title Page ──
  const titlePageParagraphs: any[] = [];
  // Spacer to center content vertically
  for (let i = 0; i < 12; i++) {
    titlePageParagraphs.push(new Paragraph({ children: [] }));
  }
  titlePageParagraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 52, font: 'Georgia' })],
    spacing: { after: 200 },
  }));
  if (subtitle) {
    titlePageParagraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: subtitle, italics: true, size: 28, font: 'Georgia' })],
      spacing: { after: 600 },
    }));
  }
  titlePageParagraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: author, size: 28, font: 'Georgia' })],
    spacing: { before: 400 },
  }));

  sections.push({
    properties: { page: { margin: margins } },
    children: titlePageParagraphs,
  });

  // ── Copyright Page ──
  const year = new Date().getFullYear();
  const copyrightText = copyright || `Copyright \u00A9 ${year} ${author}. All rights reserved.

No part of this publication may be reproduced, distributed, or transmitted in any form or by any means, including photocopying, recording, or other electronic or mechanical methods, without the prior written permission of the author.

This is a work of fiction. Names, characters, places, and incidents either are the product of the author's imagination or are used fictitiously.

First Edition: ${year}

ISBN: [ISBN placeholder]`;

  const copyrightParas: any[] = [];
  for (let i = 0; i < 20; i++) {
    copyrightParas.push(new Paragraph({ children: [] }));
  }
  for (const line of copyrightText.split('\n')) {
    copyrightParas.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: line.trim(), size: 18, font: 'Georgia' })],
      spacing: { after: 100 },
    }));
  }

  sections.push({
    properties: { type: SectionType.NEXT_PAGE, page: { margin: margins } },
    children: copyrightParas,
  });

  // ── Dedication Page (if provided) ──
  if (dedication) {
    const dedicationParas: any[] = [];
    for (let i = 0; i < 12; i++) {
      dedicationParas.push(new Paragraph({ children: [] }));
    }
    dedicationParas.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: dedication, italics: true, size: 24, font: 'Georgia' })],
    }));

    sections.push({
      properties: { type: SectionType.NEXT_PAGE, page: { margin: margins } },
      children: dedicationParas,
    });
  }

  // ═══════════════════════════════════════
  // MAIN CONTENT (chapters)
  // ═══════════════════════════════════════

  const mainParagraphs = parseMarkdownToDocx(content);

  sections.push({
    properties: { type: SectionType.NEXT_PAGE, page: { margin: margins } },
    children: mainParagraphs,
  });

  // ═══════════════════════════════════════
  // BACK MATTER
  // ═══════════════════════════════════════

  const backMatterParas: any[] = [];

  // ── Author Bio ──
  if (authorBio) {
    backMatterParas.push(new Paragraph({
      children: [new TextRun({ text: '', break: 1 }), new TextRun({ text: '' })],
    }));
    backMatterParas.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'ABOUT THE AUTHOR', bold: true, size: 28, font: 'Georgia' })],
      spacing: { after: 400 },
    }));
    for (const line of authorBio.split('\n')) {
      backMatterParas.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: line.trim(), size: 22, font: 'Georgia' })],
        spacing: { after: 200 },
      }));
    }
  }

  // ── Also By ──
  if (alsoBy && alsoBy.length > 0) {
    backMatterParas.push(new Paragraph({ children: [] }));
    backMatterParas.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `ALSO BY ${author.toUpperCase()}`, bold: true, size: 28, font: 'Georgia' })],
      spacing: { after: 400 },
    }));
    for (const book of alsoBy) {
      backMatterParas.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: book, italics: true, size: 22, font: 'Georgia' })],
        spacing: { after: 100 },
      }));
    }
  }

  // ── Newsletter CTA ──
  if (newsletterCta) {
    backMatterParas.push(new Paragraph({ children: [] }));
    backMatterParas.push(new Paragraph({ children: [] }));
    for (const line of newsletterCta.split('\n')) {
      backMatterParas.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: line.trim(), size: 22, font: 'Georgia' })],
        spacing: { after: 200 },
      }));
    }
  }

  if (backMatterParas.length > 0) {
    sections.push({
      properties: { type: SectionType.NEXT_PAGE, page: { margin: margins } },
      children: backMatterParas,
    });
  }

  // ═══════════════════════════════════════
  // BUILD DOCUMENT
  // ═══════════════════════════════════════

  const doc = new Document({
    creator: author,
    title: title,
    description: `Generated by AuthorAgent`,
    sections,
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer as Buffer;
}

/**
 * Parse markdown content into DOCX paragraphs with professional formatting.
 */
function parseMarkdownToDocx(content: string): any[] {
  const paragraphs: any[] = [];
  const lines = content.split('\n');
  let isFirstChapter = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Chapter headings (# or ## with "Chapter" in them)
    if (line.match(/^#{1,2}\s/)) {
      const headingText = line.replace(/^#{1,2}\s+/, '');

      // Page break before each chapter (except the first)
      if (!isFirstChapter) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ break: 1, text: '' })],
          pageBreakBefore: true,
        }));
      }
      isFirstChapter = false;

      // Spacer before chapter title
      for (let s = 0; s < 4; s++) {
        paragraphs.push(new Paragraph({ children: [] }));
      }

      // Chapter heading
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: headingText.toUpperCase(),
          bold: true,
          size: 28,
          font: 'Georgia',
        })],
        spacing: { after: 600 },
      }));
      continue;
    }

    // Subheadings (###)
    if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        text: line.replace(/^### /, ''),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }

    // Scene break markers
    if (line.trim().match(/^(\*\s*\*\s*\*|~~~|---|\* \* \*)$/)) {
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: '* * *', size: 22, font: 'Georgia' })],
        spacing: { before: 400, after: 400 },
      }));
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      paragraphs.push(new Paragraph({
        children: [],
        spacing: { after: 100 },
      }));
      continue;
    }

    // Regular paragraph with bold/italic handling
    const children = parseInlineFormatting(line);
    paragraphs.push(new Paragraph({
      children,
      spacing: { after: 100, line: 276 }, // ~1.15 line spacing
      indent: { firstLine: 360 }, // 0.25" first line indent
    }));
  }

  return paragraphs;
}

/**
 * Parse inline markdown formatting (bold, italic) into TextRuns.
 */
function parseInlineFormatting(text: string): any[] {
  const children: any[] = [];
  // Split by bold (**text**) and italic (*text*) markers
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*)/);

  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      children.push(new TextRun({
        text: part.slice(2, -2),
        bold: true,
        size: 22,
        font: 'Georgia',
      }));
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      children.push(new TextRun({
        text: part.slice(1, -1),
        italics: true,
        size: 22,
        font: 'Georgia',
      }));
    } else if (part) {
      children.push(new TextRun({
        text: part,
        size: 22,
        font: 'Georgia',
      }));
    }
  }

  return children;
}
