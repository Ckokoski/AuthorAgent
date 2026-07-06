/**
 * AuthorClaw Image Generation Service
 * Supports Together AI (Flux models) and OpenAI (GPT Image) for book cover generation.
 * Uses native fetch — no external dependencies.
 */

import { mkdir, writeFile, readFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { Vault } from '../security/vault.js';
import { getOpenAIImagePrice } from './pricing.js';

export interface ImageResult {
  success: boolean;
  file?: string;
  filename?: string;
  width?: number;
  height?: number;
  provider?: string;
  model?: string;
  error?: string;
}

export interface ImageGenOptions {
  provider?: 'together' | 'openai' | 'gemini' | 'openrouter' | 'auto';
  width?: number;
  height?: number;
  style?: 'realistic' | 'illustrated' | 'minimalist';
  /** OpenAI gpt-image-1 quality knob: 'low' | 'medium' | 'high' | 'auto' (default 'high' for covers) */
  quality?: 'low' | 'medium' | 'high' | 'auto';
  /**
   * Routing hint, separate from the `quality` param above (which is the
   * OpenAI render-quality knob). 'final' (default) runs the full provider
   * chain starting from the top (best output). 'draft' starts the chain at
   * the configured `draftTier` provider (default 'gemini' / Nano Banana) to
   * save money on concepts, social variants, and iteration passes — falling
   * through the remaining chain on error exactly like 'final' does.
   */
  routingTier?: 'final' | 'draft';
}

/** Providers eligible to appear in the configurable fallback chain. */
export type ImageProviderName = 'openai' | 'gemini' | 'together';

/** Persisted, user-editable image-gen settings — model slugs and routing
 *  order are settings, not code, per the owner's cheapest-best-output
 *  philosophy. Lives at workspace/data/image-gen-config.json. */
export interface ImageGenConfig {
  /** OpenAI model slug to use. Default 'gpt-image-2'; falls back once to
   *  'gpt-image-1' at request time if the configured model 404s. */
  openaiModel: string;
  /** Provider fallback order for 'auto' / 'final' routing. */
  chain: ImageProviderName[];
  /** Provider the chain starts at for 'draft'-tier calls (cheap iteration). */
  draftTier: ImageProviderName;
}

const DEFAULT_IMAGE_GEN_CONFIG: ImageGenConfig = {
  openaiModel: 'gpt-image-2',
  chain: ['openai', 'gemini', 'together'],
  draftTier: 'gemini',
};

/**
 * Standard cover sizes an author needs for the major retail platforms.
 * Each variant has the closest aspect ratio supported by gpt-image-1.
 */
export type CoverVariant = 'ebook' | 'print' | 'audiobook' | 'social';

export interface CoverSetResult {
  /** Master cover description used for the prompt across all variants. */
  promptUsed: string;
  /** Per-variant generation result, keyed by variant. */
  variants: Partial<Record<CoverVariant, ImageResult>>;
  /** Variants that succeeded — for quick check by callers. */
  successfulVariants: CoverVariant[];
  /** Total cost estimate (USD). */
  estimatedCost: number;
}

/** What each variant is for, with platform sizing notes. Used as prompt
 *  context AND as the response's documentation for the author. */
const COVER_VARIANTS: Record<CoverVariant, {
  label: string;
  width: number;
  height: number;
  aspectNote: string;
  platformNote: string;
}> = {
  ebook: {
    label: 'Ebook (Amazon Kindle / KDP)',
    width: 1024, height: 1536,
    aspectNote: '2:3 vertical',
    platformNote: 'Amazon KDP recommends 2560×1600 (1.6:1). Generated at 2:3 — upscale if your retailer requires more pixels.',
  },
  print: {
    label: 'Print paperback / hardcover (6×9 inch)',
    width: 1024, height: 1536,
    aspectNote: '2:3 vertical (matches 6×9 trim)',
    platformNote: 'For KDP print, this is the FRONT COVER ONLY. Spine + back panel must be added in your cover designer (KDP Cover Creator, Canva, Photoshop, etc.).',
  },
  audiobook: {
    label: 'Audiobook (ACX / Findaway / Spotify)',
    width: 1024, height: 1024,
    aspectNote: '1:1 square',
    platformNote: 'ACX requires 2400×2400 minimum. Generated at 1024×1024 — upscale to 2400×2400 before submitting.',
  },
  social: {
    label: 'Social promo banner',
    width: 1536, height: 1024,
    aspectNote: '3:2 landscape',
    platformNote: 'Use for Twitter / X cards, Facebook OG images, BookBub feature graphics, newsletter headers. Add title + cover thumb + tagline in your designer of choice.',
  },
};

/** 7 days — how long a discovered Gemini image model slug stays cached before re-probing. */
const GEMINI_MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface GeminiModelCacheFile {
  model: string;
  discoveredAt: string; // ISO
}

export class ImageGenService {
  private imageDir: string;
  private vault: Vault;
  private dataDir: string;
  private geminiModelCachePath: string;
  private configPath: string;
  private config: ImageGenConfig = { ...DEFAULT_IMAGE_GEN_CONFIG };

  // Together AI models
  private static readonly TOGETHER_FREE = 'black-forest-labs/FLUX.1-schnell-Free';
  private static readonly TOGETHER_PRO = 'black-forest-labs/FLUX.1.1-pro';
  // OpenAI model fallback when the configured model 404s ("model not found").
  private static readonly OPENAI_FALLBACK_MODEL = 'gpt-image-1';
  // Gemini "Nano Banana" — Gemini's image-generation models. Decent text
  // rendering, free tier, uses the same gemini_api_key the AI router needs.
  // Model availability shifts month-to-month (Google rotates preview slugs),
  // so we try several known names and cache the first one that works on the
  // user's key. New names get added as Google releases them.
  private static readonly GEMINI_IMAGE_CANDIDATES = [
    'gemini-2.5-flash-image',                    // stable promotion (Nov 2025+)
    'gemini-2.5-flash-image-preview',            // public preview slug
    'gemini-2.0-flash-preview-image-generation', // older preview slug
    'gemini-2.0-flash-exp-image-generation',     // experimental slug
  ];
  private cachedGeminiImageModel: string | null = null;

  constructor(workspaceDir: string, vault: Vault) {
    this.imageDir = join(workspaceDir, 'images');
    this.vault = vault;
    this.dataDir = join(workspaceDir, 'data');
    this.geminiModelCachePath = join(this.dataDir, 'gemini-image-model.json');
    this.configPath = join(this.dataDir, 'image-gen-config.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    await mkdir(this.dataDir, { recursive: true });
    await this.loadCachedGeminiImageModel();
    await this.loadConfig();
  }

  // ── Configurable settings (model slugs, routing chain — settings, not code) ──

  /** Load persisted settings from disk, creating the file with defaults if missing. */
  private async loadConfig(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        await this.saveConfig(DEFAULT_IMAGE_GEN_CONFIG);
        this.config = { ...DEFAULT_IMAGE_GEN_CONFIG };
        return;
      }
      const raw = await readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.config = {
        openaiModel: typeof parsed?.openaiModel === 'string' ? parsed.openaiModel : DEFAULT_IMAGE_GEN_CONFIG.openaiModel,
        chain: Array.isArray(parsed?.chain) && parsed.chain.length > 0 ? parsed.chain : DEFAULT_IMAGE_GEN_CONFIG.chain,
        draftTier: typeof parsed?.draftTier === 'string' ? parsed.draftTier : DEFAULT_IMAGE_GEN_CONFIG.draftTier,
      };
    } catch {
      // Corrupted config — fall back to defaults in memory, don't clobber the file.
      this.config = { ...DEFAULT_IMAGE_GEN_CONFIG };
    }
  }

  /** Persist settings to disk (atomic write via temp file + rename). */
  private async saveConfig(config: ImageGenConfig): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = this.configPath + '.tmp';
    await writeFile(tmp, JSON.stringify(config, null, 2));
    const { rename } = await import('fs/promises');
    await rename(tmp, this.configPath);
  }

  /** Get the current image-gen settings (model slugs, chain, draft tier). */
  getConfig(): ImageGenConfig {
    return { ...this.config, chain: [...this.config.chain] };
  }

  /** Merge + persist a partial settings update. Returns the resulting config. */
  async updateConfig(update: Partial<ImageGenConfig>): Promise<ImageGenConfig> {
    const next: ImageGenConfig = {
      openaiModel: update.openaiModel ?? this.config.openaiModel,
      chain: update.chain ?? this.config.chain,
      draftTier: update.draftTier ?? this.config.draftTier,
    };
    await this.saveConfig(next);
    this.config = next;
    return this.getConfig();
  }

  // ── Gemini model slug cache ──

  /** Load the persisted slug from disk if present and not past its TTL. */
  private async loadCachedGeminiImageModel(): Promise<void> {
    try {
      if (!existsSync(this.geminiModelCachePath)) return;
      const raw = await readFile(this.geminiModelCachePath, 'utf-8');
      const cache: GeminiModelCacheFile = JSON.parse(raw);
      if (!cache?.model || !cache?.discoveredAt) return;
      const age = Date.now() - new Date(cache.discoveredAt).getTime();
      if (age > GEMINI_MODEL_CACHE_TTL_MS) return; // stale — will re-probe
      this.cachedGeminiImageModel = cache.model;
    } catch {
      // Corrupted cache — ignore, will re-probe.
    }
  }

  /** Persist the discovered slug + timestamp so future process starts skip the probe call. */
  private async saveCachedGeminiImageModel(model: string): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const payload: GeminiModelCacheFile = { model, discoveredAt: new Date().toISOString() };
      const tmp = this.geminiModelCachePath + '.tmp';
      await writeFile(tmp, JSON.stringify(payload, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.geminiModelCachePath);
    } catch {
      // Non-fatal — worst case we re-probe next cold start.
    }
  }

  /** Invalidate the cache in-memory and on disk (called on 404 / model-not-found). */
  private async invalidateCachedGeminiImageModel(): Promise<void> {
    this.cachedGeminiImageModel = null;
    try {
      if (existsSync(this.geminiModelCachePath)) {
        const { unlink: unlinkFile } = await import('fs/promises');
        await unlinkFile(this.geminiModelCachePath);
      }
    } catch {
      // Non-fatal.
    }
  }

  /**
   * Check which image providers are available (have API keys).
   * Returned in PREFERENCE order so the dashboard can show the active fallback chain.
   */
  async getAvailableProviders(): Promise<string[]> {
    const providers: string[] = [];
    const openaiKey = await this.vault.get('openai_api_key');
    if (openaiKey) providers.push('openai');
    const geminiKey = await this.vault.get('gemini_api_key');
    if (geminiKey) providers.push('gemini');
    const togetherKey = await this.vault.get('together_api_key');
    if (togetherKey) providers.push('together');
    return providers;
  }

  /**
   * Generate an image from a text prompt.
   * Tries Together AI first (cheaper), falls back to OpenAI.
   */
  async generate(prompt: string, options: ImageGenOptions = {}): Promise<ImageResult> {
    const width = options.width || 1024;
    const height = options.height || 1536; // Book cover ratio ~2:3
    const preferredProvider = options.provider || 'auto';
    const quality = options.quality || 'high';

    // Add style prefix to prompt
    let styledPrompt = prompt;
    if (options.style === 'illustrated') {
      styledPrompt = `Digital illustration, vibrant colors, detailed artwork. ${prompt}`;
    } else if (options.style === 'minimalist') {
      styledPrompt = `Minimalist book cover design, clean typography space, simple elegant composition. ${prompt}`;
    } else if (options.style === 'realistic') {
      styledPrompt = `Photorealistic, cinematic lighting, high-detail. ${prompt}`;
    }

    // ── Provider preference order (auto) ──
    // Order comes from the persisted config (workspace/data/image-gen-config.json),
    // default openai → gemini → together:
    //   1. OpenAI (gpt-image-2, falling back to gpt-image-1) — best text rendering, paid
    //   2. Gemini Nano Banana     — solid text rendering, free tier, uses
    //                                the same gemini_api_key the AI router
    //                                already needs (so authors usually
    //                                already have it)
    //   3. Together AI Flux       — free fallback, weaker text rendering
    //
    // Explicit `provider:` values still override this preference. For
    // routingTier: 'draft' calls (concepts/social/iteration), the chain
    // starts at the configured draftTier provider instead of the top, to
    // save money — falling through the rest of the chain on error exactly
    // like 'final' does.
    const configuredChain = this.config.chain.length > 0 ? this.config.chain : DEFAULT_IMAGE_GEN_CONFIG.chain;
    let preferenceChain: ImageProviderName[] =
      preferredProvider === 'openai'   ? ['openai']
      : preferredProvider === 'gemini'   ? ['gemini']
      : preferredProvider === 'together' ? ['together']
      : [...configuredChain]; // 'auto'

    if (preferredProvider === 'auto' && options.routingTier === 'draft') {
      const draftTier = this.config.draftTier || DEFAULT_IMAGE_GEN_CONFIG.draftTier;
      const startIdx = preferenceChain.indexOf(draftTier);
      if (startIdx > 0) {
        preferenceChain = [...preferenceChain.slice(startIdx), ...preferenceChain.slice(0, startIdx)];
      }
    }

    let lastError = '';
    for (const provider of preferenceChain) {
      let result: ImageResult;
      if (provider === 'openai') {
        result = await this.generateWithOpenAI(styledPrompt, width, height, quality);
      } else if (provider === 'gemini') {
        result = await this.generateWithGemini(styledPrompt, width, height);
      } else {
        result = await this.generateWithTogether(styledPrompt, width, height);
      }
      if (result.success) return result;
      lastError = result.error || `${provider} failed without an error message`;
      // If user explicitly chose this provider, don't fall through.
      if (preferredProvider === provider) return result;
    }

    return {
      success: false,
      error: `No image provider succeeded. Last error: ${lastError}. Add an OpenAI, Gemini, or Together AI key in Settings → API Keys.`,
    };
  }

  /**
   * Generate a book cover image with smart prompting.
   */
  async generateBookCover(params: {
    title: string;
    author: string;
    genre: string;
    description: string;
    style?: 'realistic' | 'illustrated' | 'minimalist';
    /** Optional rich-prompt fields. Pass to enrich the AI's visual brief. */
    subgenre?: string;
    mood?: string;                  // e.g., "tense, claustrophobic"
    era?: string;                   // e.g., "1920s Vienna" / "near-future"
    setting?: string;               // e.g., "ancient library at midnight"
    keyImagery?: string[];          // e.g., ["a burning compass", "raven feathers"]
    palette?: string;               // e.g., "deep blue and gold" / "blood red on black"
    avoidImagery?: string;          // e.g., "no faces, no weapons"
    /** Render title + author on the cover (default true). */
    includeText?: boolean;
    typographyNote?: string;
    quality?: 'low' | 'medium' | 'high' | 'auto';
    provider?: 'together' | 'openai' | 'auto';
  }): Promise<ImageResult> {
    const coverPrompt = this.buildCoverPrompt(params);
    return this.generate(coverPrompt, {
      style: params.style || 'illustrated',
      width: 1024,
      height: 1536,
      quality: params.quality || 'high',
      provider: params.provider,
    });
  }

  /**
   * Generate the full set of standard cover sizes an author needs:
   *   ebook (vertical 2:3) — Amazon Kindle / KDP
   *   print (vertical 2:3) — Print paperback / hardcover front
   *   audiobook (1:1)      — ACX / Findaway / Spotify
   *   social (3:2)         — Twitter card / FB OG / promo banners
   *
   * All variants use the SAME visual brief so the cover-set looks
   * cohesive across formats. The model is asked to compose for the
   * given aspect ratio in each call, so the layout adapts (vertical
   * spine-friendly composition for ebook vs. landscape for social).
   *
   * Cost estimates are sourced from `pricing.ts` (gpt-image-1, high quality,
   * last verified pricing.PRICING_LAST_VERIFIED). See getOpenAIImagePrice().
   */
  async generateCoverSet(params: {
    title: string;
    author: string;
    genre: string;
    description: string;
    style?: 'realistic' | 'illustrated' | 'minimalist';
    subgenre?: string;
    mood?: string;
    era?: string;
    setting?: string;
    keyImagery?: string[];
    palette?: string;
    avoidImagery?: string;
    /** Render title + author on the cover (default true). */
    includeText?: boolean;
    typographyNote?: string;
    /** Limit to a subset of variants. Default: all four. */
    variants?: CoverVariant[];
    quality?: 'low' | 'medium' | 'high' | 'auto';
    provider?: 'together' | 'openai' | 'auto';
    /** Override the per-variant routing tier (final vs draft). By default:
     *  ebook/print/audiobook = 'final' (best output), social = 'draft'
     *  (cheaper — concepts/social variants don't need the top of the chain). */
    routingTier?: 'final' | 'draft';
  }): Promise<CoverSetResult> {
    const promptBase = this.buildCoverPrompt(params);
    const targets = params.variants || ['ebook', 'print', 'audiobook', 'social'];
    const variants: Partial<Record<CoverVariant, ImageResult>> = {};
    const successful: CoverVariant[] = [];
    let estimatedCost = 0;

    const includeText = params.includeText !== false;

    for (const variant of targets) {
      const spec = COVER_VARIANTS[variant];
      if (!spec) continue;

      // Each variant gets the same brief but a small composition hint so
      // the model lays out for the target aspect. Audiobook + social
      // variants explicitly skip on-image text (audiobook needs a thumb-
      // safe centered focal element; social needs space for an overlay).
      // Ebook + print honor the includeText flag.
      let variantHint: string;
      if (variant === 'audiobook') {
        variantHint = ' Square 1:1 composition: focal element centered, balanced both vertically and horizontally; works as a thumbnail. NO TEXT IN THE IMAGE — audiobook covers are usually re-typeset by the platform; keep the canvas clean for that.';
      } else if (variant === 'social') {
        variantHint = ' Wide 3:2 landscape composition: scene reads left-to-right; leave room for overlay text on one side. NO TEXT IN THE IMAGE — social banners get text overlays in your designer.';
      } else {
        // ebook + print
        variantHint = includeText
          ? ` Vertical 2:3 portrait composition: classic book-cover layout. Render the title "${params.title}" prominently in the upper area and the author name "${params.author}" smaller near the bottom. Letterforms must be sharp and free of artifacts.`
          : ` Vertical 2:3 portrait composition: classic book-cover layout, focal element centered, room at top for title and bottom for author name. NO TEXT in the image — title/author are overlaid in post.`;
      }

      const prompt = promptBase + variantHint;

      // Routing philosophy: best output as cheaply as possible. ebook/print/
      // audiobook covers are the deliverable — run the full chain from the
      // top ('final'). Social variants are promo/iteration material — start
      // at the cheaper draftTier provider unless the caller overrides.
      const defaultTier: 'final' | 'draft' = variant === 'social' ? 'draft' : 'final';
      const routingTier = params.routingTier || defaultTier;

      const result = await this.generate(prompt, {
        provider: params.provider || 'auto',
        style: params.style || 'illustrated',
        width: spec.width,
        height: spec.height,
        quality: params.quality || 'high',
        routingTier,
      });

      variants[variant] = result;
      if (result.success) {
        successful.push(variant);
        const modelForPricing = result.provider === 'openai' ? result.model : undefined;
        estimatedCost += getOpenAIImagePrice(spec.width, spec.height, params.quality || 'high', modelForPricing);
      }
    }

    return {
      promptUsed: promptBase,
      variants,
      successfulVariants: successful,
      estimatedCost: Math.round(estimatedCost * 100) / 100,
    };
  }

  /** List the cover-variant specs for the dashboard. */
  static getCoverVariants(): typeof COVER_VARIANTS {
    return COVER_VARIANTS;
  }

  // ── Together AI ──

  private async generateWithTogether(prompt: string, width: number, height: number): Promise<ImageResult> {
    const apiKey = await this.vault.get('together_api_key');
    if (!apiKey) {
      return { success: false, error: 'Together AI API key not configured' };
    }

    try {
      // Use free model first, fall back to pro
      const model = ImageGenService.TOGETHER_FREE;

      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          width: Math.min(width, 1440),
          height: Math.min(height, 1440),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(120000), // 2 min timeout for image gen
      });

      if (!response.ok) {
        const errText = await response.text();
        // If free model fails, try pro
        if (model === ImageGenService.TOGETHER_FREE) {
          console.log('[image-gen] Free model failed, trying pro model...');
          return this.generateWithTogetherPro(apiKey, prompt, width, height);
        }
        return { success: false, error: `Together AI error: ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) {
        return { success: false, error: 'Together AI returned empty image data' };
      }

      return this.saveImage(Buffer.from(b64, 'base64'), 'together', model, width, height);
    } catch (err) {
      return { success: false, error: `Together AI request failed: ${String(err)}` };
    }
  }

  private async generateWithTogetherPro(apiKey: string, prompt: string, width: number, height: number): Promise<ImageResult> {
    try {
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ImageGenService.TOGETHER_PRO,
          prompt,
          width: Math.min(width, 1440),
          height: Math.min(height, 1440),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `Together AI Pro error: ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return { success: false, error: 'Together AI returned empty image data' };

      return this.saveImage(Buffer.from(b64, 'base64'), 'together', ImageGenService.TOGETHER_PRO, width, height);
    } catch (err) {
      return { success: false, error: `Together AI Pro request failed: ${String(err)}` };
    }
  }

  // ── OpenAI ──

  private async generateWithOpenAI(
    prompt: string,
    width: number,
    height: number,
    quality: 'low' | 'medium' | 'high' | 'auto' = 'high',
  ): Promise<ImageResult> {
    const apiKey = await this.vault.get('openai_api_key');
    if (!apiKey) {
      return { success: false, error: 'OpenAI API key not configured' };
    }

    const configuredModel = this.config.openaiModel || DEFAULT_IMAGE_GEN_CONFIG.openaiModel;
    const result = await this.callOpenAIImages(apiKey, configuredModel, prompt, width, height, quality);
    if (result.success) return result;

    // Fall back once to gpt-image-1 if the configured model wasn't found.
    if (
      configuredModel !== ImageGenService.OPENAI_FALLBACK_MODEL &&
      this.isModelNotFoundError(result.error)
    ) {
      console.log(`[image-gen] OpenAI model "${configuredModel}" not found, falling back to "${ImageGenService.OPENAI_FALLBACK_MODEL}"`);
      return this.callOpenAIImages(apiKey, ImageGenService.OPENAI_FALLBACK_MODEL, prompt, width, height, quality);
    }

    return result;
  }

  /** Heuristic: does this OpenAI error text look like "model not found" (bad slug)? */
  private isModelNotFoundError(error?: string): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return lower.includes('404') || lower.includes('model_not_found') || (lower.includes('model') && lower.includes('not found')) || lower.includes('does not exist');
  }

  private async callOpenAIImages(
    apiKey: string,
    model: string,
    prompt: string,
    width: number,
    height: number,
    quality: 'low' | 'medium' | 'high' | 'auto',
  ): Promise<ImageResult> {
    try {
      // Map dimensions to OpenAI supported sizes
      const size = this.getOpenAISize(width, height);

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          quality,
          n: 1,
          // gpt-image-1 / gpt-image-2 always return base64 — no response_format param.
        }),
        signal: AbortSignal.timeout(180000), // 3-min cap; high quality covers can take 60-90s
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `OpenAI error (model ${model}): ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return { success: false, error: 'OpenAI returned empty image data' };

      return this.saveImage(Buffer.from(b64, 'base64'), 'openai', model, width, height);
    } catch (err) {
      return { success: false, error: `OpenAI image request failed: ${String(err)}` };
    }
  }

  private getOpenAISize(width: number, height: number): string {
    // gpt-image-1 supports exactly: 1024x1024, 1024x1536, 1536x1024, 'auto'
    const ratio = width / height;
    if (ratio < 0.8) return '1024x1536'; // Portrait (book cover)
    if (ratio > 1.2) return '1536x1024'; // Landscape
    return '1024x1024'; // Square
  }

  // ── Gemini "Nano Banana" (Gemini 2.5 Flash Image) ──

  private async generateWithGemini(prompt: string, width: number, height: number): Promise<ImageResult> {
    const apiKey = await this.vault.get('gemini_api_key');
    if (!apiKey) {
      return { success: false, error: 'Gemini API key not configured' };
    }

    // Discover or reuse a working model name. Gemini's image-generation
    // model slug rotates with Google's preview cycle — we cache the first
    // one that succeeds on this key.
    let modelName = this.cachedGeminiImageModel;
    if (!modelName) {
      modelName = await this.discoverGeminiImageModel(apiKey);
      if (!modelName) {
        return {
          success: false,
          error: `Gemini image model not available on this key. None of [${ImageGenService.GEMINI_IMAGE_CANDIDATES.join(', ')}] worked. Check your Gemini API plan — image generation may require a paid tier or a different region.`,
        };
      }
    }

    try {
      // Gemini doesn't take width/height directly. We hint aspect ratio in
      // the prompt and (when available) use the imageConfig.aspectRatio
      // generation-config field. The model picks an output resolution.
      const aspectRatio = this.getGeminiAspectRatio(width, height);
      const aspectHint = this.getGeminiAspectHint(width, height);
      const fullPrompt = `${prompt}\n\nComposition: ${aspectHint}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            // imageConfig is the newer field name; older API versions silently ignore it.
            imageConfig: { aspectRatio },
          },
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const errText = await response.text();
        // Bust the cache if the model that previously worked has been
        // retired (404 / model-not-found), then re-probe once so this call
        // doesn't fail just because the cached slug rotated out.
        if (response.status === 404) {
          await this.invalidateCachedGeminiImageModel();
          const rediscovered = await this.discoverGeminiImageModel(apiKey);
          if (rediscovered && rediscovered !== modelName) {
            return this.generateWithGemini(prompt, width, height);
          }
        }
        return { success: false, error: `Gemini image error (model ${modelName}): ${response.status} ${errText.slice(0, 250)}` };
      }

      const data = await response.json() as any;
      // Gemini returns image data as inlineData.data (base64) inside one of the parts.
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p?.inlineData?.data);
      if (!imagePart) {
        const textPart = parts.find((p: any) => typeof p?.text === 'string');
        const hint = textPart ? ` Model returned text instead of image: "${String(textPart.text).slice(0, 120)}…"` : '';
        return {
          success: false,
          error: `Gemini returned no image data from ${modelName}.${hint}`,
        };
      }

      return this.saveImage(
        Buffer.from(imagePart.inlineData.data, 'base64'),
        'gemini',
        modelName,
        width,
        height,
      );
    } catch (err) {
      return { success: false, error: `Gemini image request failed: ${String(err)}` };
    }
  }

  /**
   * Probe each candidate model with a tiny "ping" generateContent call.
   * Returns the first slug that does NOT 404. Cached per ImageGenService
   * instance — re-discovers automatically if the cached slug starts 404ing
   * (Google retires the preview).
   */
  private async discoverGeminiImageModel(apiKey: string): Promise<string | null> {
    for (const candidate of ImageGenService.GEMINI_IMAGE_CANDIDATES) {
      try {
        // Use a 1-character ping — enough to validate the slug + permissions
        // without burning a real generation.
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${candidate}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'a small dot' }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (response.status === 404) continue;       // try next candidate
        if (response.status === 400) {
          // 400 might be a parameter problem rather than missing model.
          // Treat it as "model exists" — the next real call will succeed
          // or surface a more useful error.
          this.cachedGeminiImageModel = candidate;
          await this.saveCachedGeminiImageModel(candidate);
          return candidate;
        }
        if (response.ok) {
          this.cachedGeminiImageModel = candidate;
          await this.saveCachedGeminiImageModel(candidate);
          return candidate;
        }
        // Other errors (403 quota, 429 rate-limit, 500): the model is
        // likely valid but unusable right now. Cache anyway so subsequent
        // calls fail fast with the right error.
        this.cachedGeminiImageModel = candidate;
        await this.saveCachedGeminiImageModel(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Map our (width, height) to a Gemini-supported aspect ratio string. */
  private getGeminiAspectRatio(width: number, height: number): string {
    const ratio = width / height;
    if (ratio < 0.7) return '9:16';   // tall vertical
    if (ratio < 0.9) return '2:3';    // book-cover vertical
    if (ratio > 1.3) return '16:9';   // landscape
    if (ratio > 1.1) return '3:2';    // landscape book promo
    return '1:1';                      // square
  }

  /** Plain-English aspect hint for the prompt. */
  private getGeminiAspectHint(width: number, height: number): string {
    const ratio = width / height;
    if (ratio < 0.9) return 'Vertical 2:3 portrait composition (classic book cover layout — taller than wide).';
    if (ratio > 1.1) return 'Wide 3:2 landscape composition (banner-style, wider than tall).';
    return 'Square 1:1 composition (audiobook thumbnail-friendly).';
  }

  // ── Shared ──

  private async saveImage(buffer: Buffer, provider: string, model: string, width: number, height: number): Promise<ImageResult> {
    const id = randomBytes(6).toString('hex');
    const filename = `cover-${id}.png`;
    const filePath = join(this.imageDir, filename);

    await writeFile(filePath, buffer);

    return {
      success: true,
      file: filePath,
      filename,
      width,
      height,
      provider,
      model,
    };
  }

  /**
   * Build a detailed book cover prompt from context. Optional rich fields
   * (subgenre, mood, era, setting, keyImagery, palette, avoidImagery) are
   * all woven into the brief when provided. When they're omitted, we fall
   * back to the generic genre style — still works, just less specific.
   *
   * Text rendering is ON by default — gpt-image-1 renders book-cover text
   * (title + author name) reliably and authors generally want a finished
   * cover, not a base image they have to typeset. Pass `includeText: false`
   * to get a clean image you can drop into your own designer.
   */
  private buildCoverPrompt(params: {
    title: string;
    author: string;
    genre: string;
    description: string;
    subgenre?: string;
    mood?: string;
    era?: string;
    setting?: string;
    keyImagery?: string[];
    palette?: string;
    avoidImagery?: string;
    /** When true (default), the prompt asks the model to render title +
     *  author. When false, asks for a clean image with no text. */
    includeText?: boolean;
    /** Optional: override the typography direction. */
    typographyNote?: string;
  }): string {
    const genreStyles: Record<string, string> = {
      'romance': 'warm tones, intimate atmosphere, elegant, soft lighting, couple silhouette or embrace',
      'fantasy': 'epic, magical, dramatic lighting, mystical elements, rich colors, castle or magical landscape',
      'sci-fi': 'futuristic, space, technology, neon accents, dark atmosphere, sleek design',
      'thriller': 'dark, moody, suspenseful, high contrast, shadow play, urban setting',
      'mystery': 'atmospheric, foggy, clues, dark palette, intrigue, vintage feel',
      'horror': 'dark, eerie, unsettling, dramatic shadows, sinister atmosphere',
      'literary': 'artistic, thoughtful, subtle, muted tones, symbolic imagery',
      'ya': 'vibrant, dynamic, energetic colors, bold composition, youthful',
      'nonfiction': 'clean, professional, authoritative, bold typography space, minimal imagery',
      'memoir': 'personal, warm, nostalgic, soft focus, intimate atmosphere',
      'children': 'colorful, playful, whimsical, bright, fun illustrations',
    };

    const genreKey = Object.keys(genreStyles).find(k => params.genre.toLowerCase().includes(k)) || 'literary';
    const genreStyle = genreStyles[genreKey];

    const parts: string[] = [
      `Professional book cover for "${params.title}" by ${params.author}.`,
      `Genre: ${params.genre}${params.subgenre ? ` / ${params.subgenre}` : ''}.`,
      `Style: ${genreStyle}.`,
    ];
    if (params.era) parts.push(`Era / time period: ${params.era}.`);
    if (params.setting) parts.push(`Setting: ${params.setting}.`);
    if (params.mood) parts.push(`Mood: ${params.mood}.`);
    if (params.palette) parts.push(`Color palette: ${params.palette}.`);
    if (params.keyImagery && params.keyImagery.length > 0) {
      parts.push(`Key visual elements: ${params.keyImagery.slice(0, 5).join('; ')}.`);
    }
    parts.push(`Story essence (do not depict literally — capture the feeling): ${params.description.slice(0, 300)}.`);
    if (params.avoidImagery) parts.push(`Do NOT include: ${params.avoidImagery}.`);

    // Default = include title + author typography on the cover. Authors who
    // want a clean base image to drop into their own designer pass
    // includeText: false.
    const includeText = params.includeText !== false;
    if (includeText) {
      const typoNote = params.typographyNote || `Typography style should match the ${params.genre} genre conventions`;
      parts.push(
        `RENDER TEXT ON THE COVER:`,
        `- Title: "${params.title}" — display prominently (top half is typical)`,
        `- Author name: "${params.author}" — smaller, near the bottom`,
        `- ${typoNote}.`,
        `- Letterforms must be sharp, legible, and free of artifacts.`,
        `- No misspellings, no extra words, no random characters.`,
      );
    } else {
      parts.push(
        `Composition: leave clear space at the top for title typography and at the bottom for the author name.`,
        `CRITICAL: NO TEXT in the image — title and author name will be added separately in post.`,
      );
    }
    parts.push(`Output: high-quality commercial book cover, suitable for Amazon KDP and other retailers.`);

    return parts.join(' ');
  }

  /**
   * Clean up old images (older than 7 days)
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
      const files = await readdir(this.imageDir);
      for (const file of files) {
        if (!String(file).startsWith('cover-')) continue;
        const filePath = join(this.imageDir, String(file));
        try {
          const stats = await stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await unlink(filePath);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist yet */ }

    return cleaned;
  }

  getImageDir(): string {
    return this.imageDir;
  }
}
