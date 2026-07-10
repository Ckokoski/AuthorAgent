/**
 * AuthorAgent Video Research
 *
 * Extract research from video sources for fiction/nonfiction authors.
 * Inspired by claude-video, scoped tightly to the author use case:
 *
 *   - Author writing a historical novel watches a 2-hour interview with
 *     a primary-source descendant. Tool: pull every detail relevant to
 *     "1920s Vienna coffeehouse culture" without manual transcription.
 *
 *   - Nonfiction author analyzing competing book trailers / podcast
 *     episodes for positioning research.
 *
 *   - Author reviewing their own podcast appearance for voice/style notes
 *     they can apply to memoir prose.
 *
 * Architecture:
 *   - Optional dependency on `yt-dlp` + `ffmpeg` binaries. We check at
 *     runtime; if missing, we surface a clear install hint and don't crash.
 *   - Transcript pipeline: prefer native captions (free, fast) → fall
 *     back to OpenAI Whisper API ($0.006/minute) only if the user has
 *     an OpenAI key AND the video has no captions.
 *   - Output is a plain-text transcript + an AI-generated research-notes
 *     summary keyed to the author's topic of interest.
 *
 * Safety:
 *   - Explicitly NOT a tool to repackage / republish video content.
 *   - The system prompt for the research-notes pass tells the AI to
 *     extract facts and themes for the author's research, not transcribe
 *     for redistribution.
 *   - Domains are not allowlisted (yt-dlp accepts whatever the user gives
 *     it) but the activity log records every URL processed.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { Vault } from '../security/vault.js';
import type { AIRouter } from '../ai/router.js';

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface VideoResearchResult {
  url: string;
  videoTitle?: string;
  videoDuration?: number;       // seconds
  transcriptSource: 'captions' | 'whisper' | 'unavailable';
  transcript: string;            // full transcript text
  notes: string;                 // AI-generated research notes keyed to topic
  estimatedCost: number;
  warnings: string[];
}

export interface DoctorReport {
  ytDlpInstalled: boolean;
  ffmpegInstalled: boolean;
  whisperKeyConfigured: boolean;
  ready: boolean;
  installHints: string[];
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

const RESEARCH_NOTES_PROMPT = `You are extracting research notes from a video transcript for an author's writing project.

The author will provide:
  1. A video transcript
  2. A topic or research focus

Produce STRUCTURED RESEARCH NOTES the author can use. Format:

## Key facts
- (bullet list of verifiable facts mentioned, attributed to the speaker when relevant)

## Quotes worth noting
- (1-3 short quotes — under 25 words each — that capture how something was said)

## Themes / patterns
- (recurring ideas, framings, or perspectives)

## Open questions raised
- (things the speaker mentioned but didn't resolve — useful seeds for the author's writing)

## Where this fits the author's topic
- (1-2 sentences on relevance to the stated focus)

Rules:
- Quote sparingly. Never reproduce more than 25 words per quote.
- Attribute speakers when the transcript identifies them.
- If the transcript is irrelevant to the stated topic, say so plainly.
- Do not summarize the entire video — extract only what serves the author's stated focus.
- Output ONLY the research notes — no preamble, no commentary.`;

export class VideoResearchService {
  private workspaceDir: string;
  private vault: Vault | null = null;
  private aiRouter: AIRouter | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  setDependencies(vault: Vault, aiRouter: AIRouter): void {
    this.vault = vault;
    this.aiRouter = aiRouter;
  }

  /** Probe binary availability + key config. Used by /api/video/doctor. */
  async doctor(): Promise<DoctorReport> {
    const ytDlpInstalled = await this.checkBinary('yt-dlp');
    const ffmpegInstalled = await this.checkBinary('ffmpeg');
    const whisperKeyConfigured = !!(this.vault && (await this.vault.get('openai_api_key')));
    const installHints: string[] = [];
    if (!ytDlpInstalled) {
      installHints.push(
        'Install yt-dlp: ' +
        'macOS: `brew install yt-dlp`. ' +
        'Linux: `pip install yt-dlp`. ' +
        'Windows: download from github.com/yt-dlp/yt-dlp/releases.'
      );
    }
    if (!ffmpegInstalled) {
      installHints.push(
        'Install ffmpeg: ' +
        'macOS: `brew install ffmpeg`. ' +
        'Linux: `apt install ffmpeg`. ' +
        'Windows: download from gyan.dev/ffmpeg/builds.'
      );
    }
    if (!whisperKeyConfigured) {
      installHints.push('Add an OpenAI API key in Settings to enable Whisper transcription for caption-less videos.');
    }
    return {
      ytDlpInstalled,
      ffmpegInstalled,
      whisperKeyConfigured,
      // Captions-only mode works without ffmpeg/whisper, so we report ready
      // as long as yt-dlp is present.
      ready: ytDlpInstalled,
      installHints,
    };
  }

  private async checkBinary(name: string): Promise<boolean> {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      await execAsync(cmd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Main entry point: download → transcribe → extract notes.
   * @param url Video URL (yt-dlp handles YouTube/TikTok/Vimeo/etc.)
   * @param topic Author's research focus — the AI tunes notes to this.
   */
  async extract(url: string, topic: string): Promise<VideoResearchResult> {
    const doctor = await this.doctor();
    if (!doctor.ytDlpInstalled) {
      return {
        url,
        transcriptSource: 'unavailable',
        transcript: '',
        notes: '',
        estimatedCost: 0,
        warnings: ['yt-dlp not installed. ' + doctor.installHints.join(' ')],
      };
    }

    const sanitizedUrl = this.sanitizeUrl(url);
    const id = randomBytes(6).toString('hex');
    const workDir = join(this.workspaceDir, 'video-research', id);
    await mkdir(workDir, { recursive: true });

    const warnings: string[] = [];
    let videoTitle: string | undefined;
    let videoDuration: number | undefined;
    let transcript = '';
    let transcriptSource: VideoResearchResult['transcriptSource'] = 'unavailable';
    let estimatedCost = 0;

    // 1. Probe metadata (title + duration) without downloading the video itself.
    try {
      const metaCmd = `yt-dlp --no-playlist --dump-json --skip-download ${this.shellQuote(sanitizedUrl)}`;
      const { stdout } = await execAsync(metaCmd, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
      const meta = JSON.parse(stdout);
      videoTitle = meta.title;
      videoDuration = meta.duration;
      // Soft cap on duration to prevent surprise transcription costs.
      if (videoDuration && videoDuration > 7200) {
        warnings.push(`Video is ${Math.round(videoDuration / 60)} minutes — consider using --start/--end to focus on a section.`);
      }
    } catch (err) {
      warnings.push(`Metadata probe failed: ${(err as Error)?.message?.substring(0, 200) || 'unknown'}`);
    }

    // 2. Try to grab native captions first — fastest, free.
    try {
      const subPath = join(workDir, 'subs');
      const subCmd = `yt-dlp --no-playlist --skip-download --write-auto-subs --sub-langs "en.*" --sub-format vtt --convert-subs srt -o ${this.shellQuote(subPath + '.%(ext)s')} ${this.shellQuote(sanitizedUrl)}`;
      await execAsync(subCmd, { timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
      // yt-dlp writes either .en.srt or .en-orig.srt depending on availability.
      const candidates = await this.listFiles(workDir);
      const subFile = candidates.find(f => f.endsWith('.srt'));
      if (subFile) {
        const raw = await readFile(join(workDir, subFile), 'utf-8');
        transcript = this.srtToPlainText(raw);
        transcriptSource = 'captions';
      }
    } catch {
      // Falls through to whisper attempt or unavailable.
    }

    // 3. If no captions: fall back to Whisper if user has the key + ffmpeg.
    if (!transcript && doctor.ffmpegInstalled && doctor.whisperKeyConfigured) {
      const whisperResult = await this.transcribeViaWhisper(sanitizedUrl, workDir);
      if (whisperResult.transcript) {
        transcript = whisperResult.transcript;
        transcriptSource = 'whisper';
        estimatedCost += whisperResult.cost;
      } else if (whisperResult.error) {
        warnings.push(whisperResult.error);
      }
    } else if (!transcript) {
      if (!doctor.ffmpegInstalled) warnings.push('No captions on this video and ffmpeg is not installed for Whisper fallback.');
      else if (!doctor.whisperKeyConfigured) warnings.push('No captions on this video and no OpenAI key is configured for Whisper.');
    }

    if (!transcript) {
      return {
        url, videoTitle, videoDuration, transcriptSource, transcript: '',
        notes: '', estimatedCost, warnings,
      };
    }

    // 4. Generate research notes scoped to the author's topic.
    const notes = await this.generateNotes(transcript, topic, videoTitle);

    // 5. Persist artifacts so the author can come back to them.
    try {
      await writeFile(join(workDir, 'transcript.txt'), transcript, 'utf-8');
      await writeFile(join(workDir, 'notes.md'),
        `# Research notes — ${topic}\n\n**Source**: ${videoTitle || sanitizedUrl}\n**URL**: ${sanitizedUrl}\n\n${notes}`,
        'utf-8'
      );
    } catch { /* non-fatal — keep results in memory */ }

    return {
      url: sanitizedUrl,
      videoTitle,
      videoDuration,
      transcriptSource,
      transcript,
      notes,
      estimatedCost,
      warnings,
    };
  }

  /** Whisper API transcription. Downloads audio-only, transcribes, deletes audio. */
  private async transcribeViaWhisper(url: string, workDir: string): Promise<{ transcript: string; cost: number; error?: string }> {
    if (!this.vault) return { transcript: '', cost: 0, error: 'Vault unavailable' };
    const apiKey = await this.vault.get('openai_api_key');
    if (!apiKey) return { transcript: '', cost: 0, error: 'No OpenAI key for Whisper' };

    const audioPath = join(workDir, 'audio.mp3');
    try {
      // Audio-only download. yt-dlp + ffmpeg handle the conversion.
      const dlCmd = `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 5 -o ${this.shellQuote(audioPath)} ${this.shellQuote(url)}`;
      await execAsync(dlCmd, { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
      if (!existsSync(audioPath)) {
        return { transcript: '', cost: 0, error: 'Audio download produced no file' };
      }
      const stats = await stat(audioPath);
      // Whisper has a 25 MB cap. If audio exceeds it, abort with a clear error.
      if (stats.size > 25 * 1024 * 1024) {
        await unlink(audioPath).catch(() => {});
        return { transcript: '', cost: 0, error: `Audio is ${(stats.size / 1024 / 1024).toFixed(1)} MB — exceeds Whisper's 25 MB limit. Trim with --start/--end or split the video.` };
      }

      const audioBuffer = await readFile(audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'text');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { transcript: '', cost: 0, error: `Whisper ${response.status}: ${body.substring(0, 200)}` };
      }
      const transcript = await response.text();

      // Whisper is $0.006/minute — estimate cost by file duration via ffprobe.
      let durationSec = 0;
      try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${this.shellQuote(audioPath)}`);
        durationSec = parseFloat(stdout) || 0;
      } catch { /* leave at 0 */ }
      const cost = (durationSec / 60) * 0.006;

      // Clean up the audio file — we have the transcript.
      await unlink(audioPath).catch(() => {});

      return { transcript, cost: Math.round(cost * 1000) / 1000 };
    } catch (err: any) {
      return { transcript: '', cost: 0, error: `Whisper pipeline failed: ${err?.message?.substring(0, 200) || 'unknown'}` };
    }
  }

  /** Generate research notes scoped to the author's stated topic. */
  private async generateNotes(transcript: string, topic: string, videoTitle?: string): Promise<string> {
    if (!this.aiRouter) return '(AI router unavailable — transcript saved but no notes generated)';
    const provider = this.aiRouter.selectProvider('research');
    // Cap transcript at ~40K chars (~10K words) for the notes pass to keep
    // input cost in check. Author can ask follow-ups against the full transcript.
    const sample = transcript.length > 40000
      ? transcript.slice(0, 25000) + '\n\n[... middle truncated ...]\n\n' + transcript.slice(-15000)
      : transcript;

    try {
      const response = await this.aiRouter.complete({
        provider: provider.id,
        system: RESEARCH_NOTES_PROMPT,
        messages: [{
          role: 'user',
          content: `Author's research focus: ${topic}\n\nVideo: ${videoTitle || '(untitled)'}\n\nTranscript:\n\n${sample}`,
        }],
        maxTokens: 2000,
        temperature: 0.3,
      });
      return response.text || '(empty response)';
    } catch (err) {
      return `(notes generation failed: ${(err as Error)?.message || err})`;
    }
  }

  // ── Helpers ──

  /** Strip whitespace + ensure URL starts with http(s). */
  private sanitizeUrl(url: string): string {
    const trimmed = String(url || '').trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('URL must start with http:// or https://');
    }
    return trimmed;
  }

  /** Shell-quote a string for both POSIX and Windows. */
  private shellQuote(s: string): string {
    if (process.platform === 'win32') {
      // Windows cmd: wrap in double quotes, escape internal quotes by doubling.
      return `"${s.replace(/"/g, '""')}"`;
    }
    // POSIX: single-quote and escape single quotes.
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /** Convert SRT to plain text — strip timestamps and indices. */
  private srtToPlainText(srt: string): string {
    return srt
      .split(/\r?\n\r?\n/)
      .map(block => {
        const lines = block.split(/\r?\n/);
        // Drop the index line + the timestamp line.
        return lines.slice(2).join(' ').trim();
      })
      .filter(Boolean)
      .join('\n');
  }

  private async listFiles(dir: string): Promise<string[]> {
    try {
      const { readdir } = await import('fs/promises');
      return await readdir(dir);
    } catch { return []; }
  }
}
