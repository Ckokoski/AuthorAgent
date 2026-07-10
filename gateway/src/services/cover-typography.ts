/**
 * AuthorAgent Cover Typography
 *
 * Generates an SVG cover file that composites title + author + optional
 * series badge over an existing AI-generated cover image. The SVG is
 * genre-aware: the default font family and layout is picked based on the
 * book's genre. Fonts are referenced by CSS `font-family` so the end user's
 * browser / renderer pulls them — no native dependencies needed.
 *
 * The SVG is saved next to the PNG (same directory, .svg extension) so the
 * author can open it in a browser, convert to PDF/PNG via the tool of their
 * choice, or hand-edit further in Inkscape/Illustrator.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';

export interface CoverTypographyParams {
  imagePath: string;            // Absolute path to the PNG background
  title: string;
  author: string;
  subtitle?: string;
  seriesBadge?: string;         // e.g., "Book 3 of the Shadow Court"
  genre?: string;
  titleColor?: string;          // CSS color, default = white with shadow
  authorColor?: string;
  width?: number;               // Default 1024
  height?: number;              // Default 1536
}

export interface TypographyResult {
  success: boolean;
  svgPath?: string;
  previewPath?: string;         // Future: PNG rasterization (needs lib)
  error?: string;
}

interface GenreStyle {
  titleFont: string;
  authorFont: string;
  titleCase: 'uppercase' | 'normal' | 'small-caps';
  titleWeight: string;
  authorWeight: string;
  alignment: 'center' | 'left' | 'right';
}

// Genre → typography guidance. Aligns with common bestseller conventions
// (romance: script + italic serif; thriller: bold sans uppercase; fantasy:
// heavy serif or display; literary: tall serif; sci-fi: geometric sans).
const GENRE_STYLES: Record<string, GenreStyle> = {
  romance: {
    titleFont: '"Playfair Display", "Cormorant Garamond", Georgia, serif',
    authorFont: '"Playfair Display", Georgia, serif',
    titleCase: 'normal',
    titleWeight: '700',
    authorWeight: '400',
    alignment: 'center',
  },
  thriller: {
    titleFont: '"Oswald", "Montserrat", "Impact", sans-serif',
    authorFont: '"Montserrat", Arial, sans-serif',
    titleCase: 'uppercase',
    titleWeight: '900',
    authorWeight: '600',
    alignment: 'center',
  },
  mystery: {
    titleFont: '"Oswald", "Bebas Neue", "Impact", sans-serif',
    authorFont: '"Montserrat", Arial, sans-serif',
    titleCase: 'uppercase',
    titleWeight: '800',
    authorWeight: '500',
    alignment: 'center',
  },
  fantasy: {
    titleFont: '"Cinzel", "Trajan Pro", "Cormorant Garamond", serif',
    authorFont: '"Cinzel", Georgia, serif',
    titleCase: 'small-caps',
    titleWeight: '700',
    authorWeight: '500',
    alignment: 'center',
  },
  scifi: {
    titleFont: '"Exo 2", "Orbitron", "Montserrat", sans-serif',
    authorFont: '"Exo 2", Arial, sans-serif',
    titleCase: 'uppercase',
    titleWeight: '700',
    authorWeight: '400',
    alignment: 'center',
  },
  'sci-fi': {
    titleFont: '"Exo 2", "Orbitron", "Montserrat", sans-serif',
    authorFont: '"Exo 2", Arial, sans-serif',
    titleCase: 'uppercase',
    titleWeight: '700',
    authorWeight: '400',
    alignment: 'center',
  },
  literary: {
    titleFont: '"Cormorant Garamond", "Libre Caslon Text", Georgia, serif',
    authorFont: '"Cormorant Garamond", Georgia, serif',
    titleCase: 'normal',
    titleWeight: '600',
    authorWeight: '400',
    alignment: 'center',
  },
  horror: {
    titleFont: '"Bebas Neue", "Oswald", "Impact", sans-serif',
    authorFont: '"Oswald", Arial, sans-serif',
    titleCase: 'uppercase',
    titleWeight: '900',
    authorWeight: '500',
    alignment: 'center',
  },
  ya: {
    titleFont: '"Montserrat", "Raleway", "Avenir", sans-serif',
    authorFont: '"Montserrat", Arial, sans-serif',
    titleCase: 'normal',
    titleWeight: '800',
    authorWeight: '500',
    alignment: 'center',
  },
  children: {
    titleFont: '"Fredoka", "Baloo 2", "Comic Sans MS", sans-serif',
    authorFont: '"Fredoka", Arial, sans-serif',
    titleCase: 'normal',
    titleWeight: '700',
    authorWeight: '500',
    alignment: 'center',
  },
  nonfiction: {
    titleFont: '"Lora", Georgia, serif',
    authorFont: '"Montserrat", Arial, sans-serif',
    titleCase: 'normal',
    titleWeight: '700',
    authorWeight: '500',
    alignment: 'center',
  },
  default: {
    titleFont: '"Playfair Display", Georgia, serif',
    authorFont: '"Montserrat", Arial, sans-serif',
    titleCase: 'normal',
    titleWeight: '700',
    authorWeight: '500',
    alignment: 'center',
  },
};

export class CoverTypographyService {
  /**
   * Build an SVG cover file layered over the given PNG background.
   * The PNG is embedded as base64 so the resulting .svg is self-contained.
   */
  async apply(params: CoverTypographyParams): Promise<TypographyResult> {
    if (!existsSync(params.imagePath)) {
      return { success: false, error: `Cover image not found: ${params.imagePath}` };
    }

    try {
      const imgBuf = await readFile(params.imagePath);
      const imgB64 = imgBuf.toString('base64');
      const mime = params.imagePath.toLowerCase().endsWith('.jpg') || params.imagePath.toLowerCase().endsWith('.jpeg')
        ? 'image/jpeg' : 'image/png';

      const width = params.width ?? 1024;
      const height = params.height ?? 1536;
      const genre = (params.genre || 'default').toLowerCase().replace(/[^a-z-]/g, '');
      const style = GENRE_STYLES[genre] || GENRE_STYLES.default;

      const titleColor = params.titleColor || '#ffffff';
      const authorColor = params.authorColor || '#f5f5f5';

      // Typography math: title fills ~60-80% of width, scaled by word count.
      const titleLines = this.wrapTitle(params.title, 14);
      const titleFontSize = this.fitFontSize(params.title, width * 0.85, 1.2, 92, 180);
      const authorFontSize = Math.max(38, Math.round(titleFontSize * 0.35));
      const subtitleFontSize = Math.max(28, Math.round(titleFontSize * 0.28));
      const badgeFontSize = Math.max(22, Math.round(titleFontSize * 0.18));

      // Layout: badge top, title middle-upper third, subtitle under, author bottom.
      const badgeY = height * 0.08;
      const titleStartY = height * 0.32;
      const authorY = height * 0.92;
      const subtitleY = titleStartY + (titleLines.length * titleFontSize * 1.05) + 20;

      const titleCaseCss = style.titleCase === 'uppercase' ? 'uppercase'
        : style.titleCase === 'small-caps' ? 'normal' : 'none';
      const fontVariant = style.titleCase === 'small-caps' ? 'small-caps' : 'normal';

      // Escape text for XML.
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const titleTspans = titleLines.map((line, i) =>
        `<tspan x="${width / 2}" dy="${i === 0 ? 0 : '1.1em'}">${esc(line)}</tspan>`
      ).join('');

      const shadowFilter = `
    <filter id="textShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
      <feOffset dx="0" dy="4" result="offsetblur"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.7"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="70%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="black" stop-opacity="0.35"/>
      <stop offset="30%" stop-color="black" stop-opacity="0"/>
    </linearGradient>`;

      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>${shadowFilter}</defs>
  <image href="data:${mime};base64,${imgB64}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="0" width="${width}" height="${height * 0.25}" fill="url(#topFade)"/>
  <rect x="0" y="${height * 0.6}" width="${width}" height="${height * 0.4}" fill="url(#bottomFade)"/>
  ${params.seriesBadge ? `
  <text x="${width / 2}" y="${badgeY}"
        font-family='${style.titleFont}'
        font-size="${badgeFontSize}"
        font-weight="500"
        fill="${titleColor}"
        text-anchor="middle"
        letter-spacing="4"
        style="text-transform: uppercase;"
        filter="url(#textShadow)">${esc(params.seriesBadge)}</text>` : ''}
  <text x="${width / 2}" y="${titleStartY}"
        font-family='${style.titleFont}'
        font-size="${titleFontSize}"
        font-weight="${style.titleWeight}"
        fill="${titleColor}"
        text-anchor="middle"
        font-variant="${fontVariant}"
        letter-spacing="2"
        style="text-transform: ${titleCaseCss};"
        filter="url(#textShadow)">${titleTspans}</text>
  ${params.subtitle ? `
  <text x="${width / 2}" y="${subtitleY}"
        font-family='${style.titleFont}'
        font-size="${subtitleFontSize}"
        font-weight="400"
        fill="${titleColor}"
        text-anchor="middle"
        font-style="italic"
        filter="url(#textShadow)">${esc(params.subtitle)}</text>` : ''}
  <text x="${width / 2}" y="${authorY}"
        font-family='${style.authorFont}'
        font-size="${authorFontSize}"
        font-weight="${style.authorWeight}"
        fill="${authorColor}"
        text-anchor="middle"
        letter-spacing="6"
        style="text-transform: uppercase;"
        filter="url(#textShadow)">${esc(params.author)}</text>
</svg>`;

      // Save alongside the PNG with .svg extension.
      const svgPath = join(dirname(params.imagePath), basename(params.imagePath).replace(/\.\w+$/, '') + '-typography.svg');
      await writeFile(svgPath, svg, 'utf-8');

      return { success: true, svgPath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  /**
   * Wrap a title into lines of roughly `maxCharsPerLine` without breaking words.
   * Aims for 1-3 lines. Single-word titles return as one line.
   */
  private wrapTitle(title: string, maxCharsPerLine: number): string[] {
    const words = title.trim().split(/\s+/);
    if (words.length === 1) return [title];

    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      if (!current) {
        current = w;
      } else if ((current + ' ' + w).length <= maxCharsPerLine) {
        current += ' ' + w;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);

    // Prefer balanced 2-line breaks over 3+ lines for short titles.
    if (lines.length > 2 && title.length < maxCharsPerLine * 2.2) {
      const mid = Math.ceil(words.length / 2);
      return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
    }
    return lines;
  }

  /**
   * Heuristic font-size fitter: scales down as title gets longer.
   */
  private fitFontSize(title: string, _widthLimit: number, _lineHeight: number, minSize: number, maxSize: number): number {
    const len = title.length;
    if (len < 12) return maxSize;
    if (len < 20) return Math.round(maxSize * 0.85);
    if (len < 30) return Math.round(maxSize * 0.7);
    if (len < 45) return Math.round(maxSize * 0.55);
    return minSize;
  }
}
