/**
 * AuthorAgent Soul Service
 * Loads and manages the three-part soul: personality, style guide, voice profile
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export class SoulService {
  private soulDir: string;
  private personality = '';
  private personalityOverride = '';
  private styleGuide = '';
  private voiceProfile = '';
  private name = 'AuthorAgent';

  constructor(soulDir: string) {
    this.soulDir = soulDir;
  }

  async load(): Promise<void> {
    // Load personality
    const soulPath = join(this.soulDir, 'SOUL.md');
    if (existsSync(soulPath)) {
      this.personality = await readFile(soulPath, 'utf-8');
      // Extract name from first heading
      const nameMatch = this.personality.match(/^#\s+(.+)/m);
      if (nameMatch) this.name = nameMatch[1].trim();
    }

    // Load optional personality override (e.g., snarky, formal, etc.)
    // This file is user-created and NOT shipped with AuthorAgent
    const personalityPath = join(this.soulDir, 'PERSONALITY.md');
    if (existsSync(personalityPath)) {
      this.personalityOverride = await readFile(personalityPath, 'utf-8');
    }

    // Load style guide
    const stylePath = join(this.soulDir, 'STYLE-GUIDE.md');
    if (existsSync(stylePath)) {
      this.styleGuide = await readFile(stylePath, 'utf-8');
    }

    // Load voice profile (learned from author's writing)
    const voicePath = join(this.soulDir, 'VOICE-PROFILE.md');
    if (existsSync(voicePath)) {
      this.voiceProfile = await readFile(voicePath, 'utf-8');
    }
  }

  getName(): string {
    return this.name;
  }

  getFullContext(): string {
    let context = '';

    if (this.personality) {
      context += this.personality + '\n\n';
    }

    // Personality override comes right after soul — it modifies chat tone
    // without affecting writing output quality
    if (this.personalityOverride) {
      context += this.personalityOverride + '\n\n';
    }

    if (this.styleGuide) {
      context += '## Writing Style Guide\n\n' + this.styleGuide + '\n\n';
    }

    if (this.voiceProfile) {
      context += '## Author Voice Profile\n\n' + this.voiceProfile + '\n\n';
    }

    return context || 'You are AuthorAgent, a helpful writing assistant for authors.';
  }

  async updateVoiceProfile(analysis: string): Promise<void> {
    const voicePath = join(this.soulDir, 'VOICE-PROFILE.md');
    const { writeFile } = await import('fs/promises');
    await writeFile(voicePath, analysis);
    this.voiceProfile = analysis;
  }
}
