/**
 * AuthorAgent Character Persona Agents
 *
 * A QUALITY MOAT: each major character becomes a STANDING CRITIC of their own
 * dialogue. Given a chapter, the service extracts each character's spoken lines
 * and — framing the model AS that character's dedicated dialogue coach — flags
 * lines that are:
 *   - off-voice               (register / vocabulary / rhythm vs. the character's
 *                              voice fingerprint)
 *   - anachronistic-knowledge (the character references something they couldn't
 *                              know yet, given their KNOWLEDGE HORIZON)
 *   - off-motivation          (the line contradicts the character's arc /
 *                              attributes / established motivation)
 *
 * Nobody else's writing tool runs persistent per-character self-critique. The
 * value proposition is a defensible, in-voice REWRITE suggestion for each flag,
 * not a vague "this feels off".
 *
 * ─── What this REUSES (does not rebuild) ───────────────────────────────────
 *   • character-voices.ts   — per-character StyleProfile fingerprints
 *                             (getProjectVoices) + the shared dialogue extraction
 *                             it delegates to dialogue-parser.ts.
 *   • dialogue-parser.ts    — extractSpokenText / matchSpeakerTag / buildNameLookup
 *                             to pull a character's lines out of a chapter.
 *   • context-engine.ts     — EntityEntry (attributes + arc via description +
 *                             change-log) and ChapterSummary (what's happened so
 *                             far → the knowledge horizon).
 *   • router.ts TASK_TIERS  — 'style_analysis' (mid) tier per character critique.
 *
 * ─── Cost discipline ───────────────────────────────────────────────────────
 * ONE 'style_analysis'-tier AI call PER CHARACTER (per-character keeps the coach
 * focused on ONE voice), CAPPED at the top N speaking characters in the chapter
 * (default 5). Characters with too few lines are skipped (no call). So a run is
 * at most N calls; typically far fewer. Brief assembly is pure — no AI.
 */

import type {
  ChapterSummary,
  EntityEntry,
  AICompleteFn,
  AISelectProviderFn,
} from './context-engine.js';
import type { StyleProfile } from './style-clone.js';
import type { CharacterVoicesService } from './character-voices.js';
import {
  splitParagraphs,
  startsWithQuote,
  extractSpokenText,
  matchSpeakerTag,
  buildNameLookup,
} from './dialogue-parser.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

/** The three kinds of out-of-character flags a persona agent can raise. */
export type CharacterFlagIssue = 'off-voice' | 'anachronistic-knowledge' | 'off-motivation';

const VALID_ISSUES = new Set<string>(['off-voice', 'anachronistic-knowledge', 'off-motivation']);

/**
 * A compact, in-character profile assembled for one character. This is what the
 * persona agent is briefed with before it critiques the character's dialogue.
 * Pure assembly — no AI, no I/O.
 */
export interface CharacterBrief {
  /** Canonical character name. */
  name: string;
  /** Names/titles the character is also known by. */
  aliases: string[];
  /** One-line description from the entity DB. */
  description: string;
  /** Established key/value facts (from EntityEntry.attributes). */
  attributes: Record<string, string>;
  /** Arc / motivation signals: the entity change-log rendered as a timeline of
   *  how this character's facts evolved (chapterId → what changed). */
  arc: Array<{ chapterId: string; description: string }>;
  /** Other characters this character has shared a chapter with (co-appearance
   *  is our cheap proxy for "known relationships"). */
  knownRelationships: string[];
  /**
   * The KNOWLEDGE HORIZON: what the character can plausibly know so far,
   * derived from the chapters they have actually APPEARED in. A line that
   * references an event from a chapter the character was absent from (or a
   * future chapter) is a candidate anachronistic-knowledge flag.
   */
  knowledgeHorizon: {
    /** Chapter numbers the character appears in (sorted ascending). */
    chaptersPresent: number[];
    /** Highest chapter number the character has appeared in — the frontier of
     *  what they can know. 0 when they have never appeared in a summarized chapter. */
    latestChapterPresent: number;
    /** Short human-readable digest of events the character witnessed (one line
     *  per present chapter), fed to the coach as "what they know". */
    knownEvents: string[];
  };
  /** Whether a StyleClone voice fingerprint was available for this character. */
  hasFingerprint: boolean;
  /** A compact, human/AI-readable summary of the voice fingerprint markers most
   *  useful for register/rhythm judgement. Empty when no fingerprint exists. */
  voiceSignature: string;
}

/** A single out-of-character line flagged by a persona agent. */
export interface CharacterFlag {
  /** The quoted line as it appears in the chapter. */
  line: string;
  issue: CharacterFlagIssue;
  /** Why this line is out of character. */
  reason: string;
  /** An in-voice rewrite that fixes it. */
  suggestion: string;
}

/** Per-character critique block within the report. */
export interface CharacterCritique {
  character: string;
  /** How many lines of this character's dialogue were reviewed. */
  linesReviewed: number;
  flags: CharacterFlag[];
}

/** The aggregated report from one critiqueDialogue() run. */
export interface CharacterCritiqueReport {
  projectId: string;
  chapterId?: string;
  generatedAt: string;
  /** Canonical names of the characters actually reviewed (an AI call was made). */
  charactersReviewed: string[];
  /** Total flags across all characters. */
  totalFlags: number;
  byCharacter: CharacterCritique[];
}

export interface CritiqueInput {
  projectId: string;
  chapterText: string;
  chapterId?: string;
  /** Optional filter — critique only these characters (by canonical name or
   *  alias). Unknown names are ignored; omitting runs the top speakers. */
  characters?: string[];
}

// ═══════════════════════════════════════════════════════════
// Tuning
// ═══════════════════════════════════════════════════════════

/** Minimum spoken lines a character needs before we spend a call on them. */
const MIN_LINES_FOR_CRITIQUE = 3;
/** Hard cap on AI calls per run — critique the top-N speaking characters only. */
const MAX_CHARACTERS_PER_RUN = 5;
/**
 * character-voices.ts's original speech-verb list (a narrower set than the
 * shared default). We match it so line-attribution behaves identically to the
 * voice-fingerprint pipeline the briefs come from.
 */
const CHARACTER_AGENT_SPEECH_VERBS = [
  'said', 'asked', 'whispered', 'shouted', 'murmured', 'replied', 'added',
  'continued', 'growled', 'hissed', 'breathed', 'spat', 'snapped', 'laughed',
  'cried', 'exclaimed', 'gasped', 'muttered', 'sighed', 'stammered',
];

// ═══════════════════════════════════════════════════════════
// AI prompt
// ═══════════════════════════════════════════════════════════

const COACH_SYSTEM_PROMPT = `You are a DIALOGUE COACH for ONE specific character in a novel. You know this character's voice, established facts, arc, and exactly what they could know at this point in the story. You are given that character's BRIEF, followed by the lines they speak in one chapter (numbered).

Your job: review ONLY this character's lines and flag any that are OUT OF CHARACTER. Judge each line against the brief:
- "off-voice": the register, vocabulary, or rhythm is wrong for this character's voice fingerprint (e.g. a terse, plain-spoken character suddenly using ornate, latinate diction; a formal character using slang; wrong sentence rhythm).
- "anachronistic-knowledge": the line references something the character COULD NOT KNOW YET given their knowledge horizon (an event from a chapter they were absent from, a future revelation, a fact no one has told them).
- "off-motivation": the line contradicts the character's arc, attributes, or established motivation (says or wants something at odds with who they are / what they want).

Rules:
- Judge ONLY the given character's lines. Ignore everything else.
- Be conservative. A line that is merely fine, or a NEW but plausible detail, is NOT a flag. Only flag genuine out-of-character breaks.
- For every flag, quote the offending line, explain WHY (referencing the brief), and give an in-voice REWRITE that fixes it while preserving the line's story function.
- If nothing is out of character, return an empty list.

Return ONLY valid JSON. No markdown code fences. No commentary. Close every brace and bracket.
Shape:
{"flags":[{"line":"the exact line","issue":"off-voice","reason":"...","suggestion":"an in-voice rewrite"}]}
If none: {"flags":[]}`;

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class CharacterAgentService {
  private characterVoices: CharacterVoicesService | null;

  /**
   * @param characterVoices  optional — when wired, buildCharacterBrief pulls the
   *   character's StyleClone voice fingerprint from it. Optional so the service
   *   (and its tests) work without the voice pipeline; briefs just lack a
   *   voiceSignature then.
   */
  constructor(characterVoices?: CharacterVoicesService | null) {
    this.characterVoices = characterVoices ?? null;
  }

  // ── Brief assembly (pure — no AI) ────────────────────────

  /**
   * Assemble a compact in-character brief for one entity from its attributes,
   * arc (change-log), co-appearance relationships, derived knowledge horizon,
   * and (when available) its voice fingerprint.
   *
   * @param entity           the character EntityEntry (from getEntitiesByType).
   * @param chapterSummaries the project's chapter summaries (chapter-sorted).
   * @param fingerprint      optional explicit voice fingerprint. When omitted,
   *                         it is looked up from the wired CharacterVoices store
   *                         if one is available (async lookup happens in
   *                         critiqueDialogue; this method stays pure/sync).
   */
  buildCharacterBrief(
    entity: EntityEntry,
    chapterSummaries: ChapterSummary[],
    fingerprint?: StyleProfile | null,
  ): CharacterBrief {
    const summaries = chapterSummaries ?? [];
    const nameKeys = this.nameKeysFor(entity);

    // ── Knowledge horizon: which chapters did this character appear in? ──
    // A character can only know things from chapters they were present for.
    const present: ChapterSummary[] = summaries.filter((s) =>
      (s.characters ?? []).some((c) => nameKeys.has(String(c).toLowerCase().trim())),
    );
    const chaptersPresent = present
      .map((s) => s.chapterNumber)
      .filter((n) => typeof n === 'number')
      .sort((a, b) => a - b);
    const latestChapterPresent = chaptersPresent.length ? chaptersPresent[chaptersPresent.length - 1] : 0;
    const knownEvents = present.map(
      (s) => `Ch ${s.chapterNumber} "${s.title}": ${s.endingState || s.summary || ''}`.trim(),
    );

    // ── Known relationships: characters co-appearing in the same chapters ──
    const relationships = new Set<string>();
    for (const s of present) {
      for (const other of s.characters ?? []) {
        const key = String(other).toLowerCase().trim();
        if (!key || nameKeys.has(key)) continue; // skip self + aliases
        relationships.add(String(other).trim());
      }
    }

    return {
      name: entity.name,
      aliases: entity.aliases ?? [],
      description: entity.description ?? '',
      attributes: entity.attributes ?? {},
      arc: (entity.changes ?? []).map((c) => ({ chapterId: c.chapterId, description: c.description })),
      knownRelationships: Array.from(relationships).sort(),
      knowledgeHorizon: {
        chaptersPresent,
        latestChapterPresent,
        knownEvents,
      },
      hasFingerprint: !!fingerprint,
      voiceSignature: fingerprint ? this.summarizeFingerprint(fingerprint) : '',
    };
  }

  // ── Critique (AI — one call per character, capped) ───────

  /**
   * Extract each major character's dialogue from the chapter and run a
   * per-character 'style_analysis'-tier critique. Returns a structured report.
   *
   * Never throws on bad AI output — a malformed/empty response for a character
   * yields that character with an empty flags list (they were still "reviewed").
   * A genuine provider transport error DOES propagate (the caller decides how to
   * treat provider outages), matching ContradictionDetector's contract.
   */
  async critiqueDialogue(
    input: CritiqueInput,
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
    // Entities + summaries are passed in (route pulls them from ContextEngine's
    // cached getters) so this service stays free of persistence concerns.
    entities: EntityEntry[],
    chapterSummaries: ChapterSummary[],
  ): Promise<CharacterCritiqueReport> {
    const characters = (entities ?? []).filter((e) => e.type === 'character');
    const summaries = chapterSummaries ?? [];

    // ── (a) Build the canonical name lookup + extract dialogue by character ──
    const canonicalNames: string[] = [];
    const aliasMap: Record<string, string[]> = {};
    for (const c of characters) {
      canonicalNames.push(c.name);
      if (c.aliases?.length) aliasMap[c.name] = c.aliases;
    }
    const linesByCharacter = this.extractLinesByCharacter(input.chapterText, canonicalNames, aliasMap);

    // ── (b) Decide which characters to critique ──
    // Optional explicit filter (canonicalized), else the top speakers by line
    // count. Always: skip characters below the min-lines threshold, cap at N.
    let candidates = characters;
    if (Array.isArray(input.characters) && input.characters.length > 0) {
      const wanted = new Set(input.characters.map((n) => String(n).toLowerCase().trim()));
      candidates = characters.filter((c) => {
        const keys = this.nameKeysFor(c);
        for (const k of keys) if (wanted.has(k)) return true;
        return false;
      });
    }

    const eligible = candidates
      .map((c) => ({ entity: c, lines: linesByCharacter.get(c.name) ?? [] }))
      .filter((x) => x.lines.length >= MIN_LINES_FOR_CRITIQUE)
      .sort((a, b) => b.lines.length - a.lines.length)
      .slice(0, MAX_CHARACTERS_PER_RUN);

    // ── (c) Look up voice fingerprints (async, once) if the store is wired ──
    const fingerprints = await this.loadFingerprints(input.projectId, eligible.map((x) => x.entity.name));

    // ── (d) One critique call per eligible character ──
    const byCharacter: CharacterCritique[] = [];
    for (const { entity, lines } of eligible) {
      const brief = this.buildCharacterBrief(entity, summaries, fingerprints.get(entity.name) ?? null);
      const flags = await this.critiqueOneCharacter(brief, lines, aiComplete, aiSelectProvider);
      byCharacter.push({
        character: entity.name,
        linesReviewed: lines.length,
        flags,
      });
    }

    const totalFlags = byCharacter.reduce((sum, c) => sum + c.flags.length, 0);
    return {
      projectId: input.projectId,
      chapterId: input.chapterId,
      generatedAt: new Date().toISOString(),
      charactersReviewed: byCharacter.map((c) => c.character),
      totalFlags,
      byCharacter,
    };
  }

  // ── One-character critique call ──────────────────────────

  private async critiqueOneCharacter(
    brief: CharacterBrief,
    lines: string[],
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<CharacterFlag[]> {
    // Honor the cost tier: per-character critique is a voice/style judgement →
    // the mid 'style_analysis' tier (never premium).
    const provider = aiSelectProvider('style_analysis');

    const numberedLines = lines.map((l, i) => `${i + 1}. "${l}"`).join('\n');
    const userContent = [
      `=== CHARACTER BRIEF: ${brief.name} ===`,
      this.renderBrief(brief),
      '',
      `=== ${brief.name}'S LINES IN THIS CHAPTER ===`,
      numberedLines || '(no lines)',
    ].join('\n');

    let raw = '';
    try {
      const response = await aiComplete({
        provider: provider.id,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        // A single character's flag list is short. 3072 leaves room for a
        // handful of quoted-line + rewrite findings without bloating cost.
        maxTokens: 3072,
        temperature: 0.2,
      });
      raw = response?.text ?? '';
    } catch (err) {
      // Provider transport error — re-throw so the caller can surface the
      // outage (matches ContradictionDetector). Malformed OUTPUT (below) does
      // not throw; only transport does.
      throw err;
    }

    return this.parseFlags(raw);
  }

  // ── Dialogue extraction (reuses dialogue-parser) ─────────

  /**
   * Extract spoken lines from the chapter and bucket them by canonical
   * character. Mirrors CharacterVoicesService.extractDialogue's attribution
   * (explicit / reverse tag → known-name validation → turn-taking fallback) so
   * a character's lines here are the same lines their voice fingerprint sees.
   */
  private extractLinesByCharacter(
    chapterText: string,
    characterNames: string[],
    aliases: Record<string, string[]>,
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const lookup = buildNameLookup(characterNames, aliases);
    const paragraphs = splitParagraphs(chapterText || '');
    let lastSpeaker: string | null = null;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!startsWithQuote(trimmed)) continue;

      const spoken = extractSpokenText(trimmed);
      if (!spoken) continue;

      let speaker: string | null = null;
      let confident = false;

      const tag = matchSpeakerTag(trimmed, { speechVerbs: CHARACTER_AGENT_SPEECH_VERBS });
      if (tag) {
        const canonical = lookup.get(tag.name.toLowerCase());
        if (canonical) {
          speaker = canonical;
          lastSpeaker = canonical;
          confident = true;
        }
        // Unknown tagged name → not one of our tracked characters; skip (don't
        // pin it on lastSpeaker, since a real different speaker just spoke).
      } else if (lastSpeaker) {
        // Bare dialogue — turn-taking heuristic (lower confidence, but the
        // voice pipeline accepts these too at 0.5).
        speaker = lastSpeaker;
        confident = true;
      }

      if (speaker && confident) {
        if (!out.has(speaker)) out.set(speaker, []);
        out.get(speaker)!.push(spoken);
      }
    }
    return out;
  }

  // ── Fingerprint lookup ───────────────────────────────────

  /** Pull the stored voice fingerprint for each named character, if the voices
   *  store is wired and has one. Never throws — returns an empty map on trouble. */
  private async loadFingerprints(
    projectId: string,
    names: string[],
  ): Promise<Map<string, StyleProfile>> {
    const map = new Map<string, StyleProfile>();
    if (!this.characterVoices || names.length === 0) return map;
    try {
      const store = await this.characterVoices.getProjectVoices(projectId);
      const byLower = new Map<string, StyleProfile>();
      for (const voice of Object.values(store.characters ?? {})) {
        if (voice.fingerprint) byLower.set(voice.characterName.toLowerCase(), voice.fingerprint);
      }
      for (const name of names) {
        const fp = byLower.get(name.toLowerCase());
        if (fp) map.set(name, fp);
      }
    } catch {
      /* voices store unavailable — briefs just lack a voice signature */
    }
    return map;
  }

  // ── Rendering helpers ────────────────────────────────────

  /** Compact, model-readable rendering of a brief. */
  private renderBrief(brief: CharacterBrief): string {
    const lines: string[] = [];
    if (brief.description) lines.push(`Description: ${brief.description}`);
    if (brief.aliases.length) lines.push(`Also known as: ${brief.aliases.join(', ')}`);

    const attrs = Object.entries(brief.attributes);
    if (attrs.length) {
      lines.push(`Established facts: ${attrs.map(([k, v]) => `${k}=${v}`).join('; ')}`);
    }

    if (brief.knownRelationships.length) {
      lines.push(`Knows / has met: ${brief.knownRelationships.join(', ')}`);
    }

    if (brief.arc.length) {
      lines.push('Arc / how their facts changed over the story:');
      for (const a of brief.arc) lines.push(`  • [${a.chapterId}] ${a.description}`);
    }

    const kh = brief.knowledgeHorizon;
    lines.push(
      `KNOWLEDGE HORIZON: present in chapter(s) ${kh.chaptersPresent.length ? kh.chaptersPresent.join(', ') : '(none yet)'}; ` +
        `they can only know events up to chapter ${kh.latestChapterPresent}. They CANNOT reference anything from chapters they were absent from or that comes later.`,
    );
    if (kh.knownEvents.length) {
      lines.push('What they have witnessed (their knowledge boundary):');
      for (const e of kh.knownEvents) lines.push(`  • ${e}`);
    }

    if (brief.voiceSignature) {
      lines.push(`VOICE FINGERPRINT (their established register/rhythm): ${brief.voiceSignature}`);
    } else {
      lines.push('VOICE FINGERPRINT: (not yet established — judge voice from the description + facts above.)');
    }

    return lines.join('\n');
  }

  /**
   * Summarize the StyleClone markers most useful for register/rhythm judgement
   * into a one-line signature the coach can compare lines against.
   */
  private summarizeFingerprint(fp: StyleProfile): string {
    const m = fp.markers;
    const parts: string[] = [];
    parts.push(`avg sentence ${round(m.avgSentenceLength)} words`);
    parts.push(`${pct(m.shortSentencePct)} short / ${pct(m.longSentencePct)} long sentences`);
    parts.push(`contractions ${round(m.contractionRate)}/1k`);
    parts.push(`adverbs ${round(m.adverbRate)}/1k`);
    parts.push(`hedging ${round(m.hedgingRate)}/1k`);
    parts.push(`intensifiers ${round(m.intensifierRate)}/1k`);
    parts.push(`questions ${round(m.questionMarkRate)}/1k`);
    parts.push(`exclamations ${round(m.exclamationRate)}/1k`);
    parts.push(`fragments ${round(m.fragmentRate)}/1k`);
    parts.push(`avg word length ${round(m.avgWordLength)}`);
    const sig = fp.signature ? `${fp.signature} — ` : '';
    return `${sig}${parts.join(', ')}`;
  }

  /** All lowercase keys (canonical + aliases) that identify an entity. */
  private nameKeysFor(entity: EntityEntry): Set<string> {
    const keys = new Set<string>();
    if (entity.name) keys.add(entity.name.toLowerCase().trim());
    for (const a of entity.aliases ?? []) keys.add(String(a).toLowerCase().trim());
    return keys;
  }

  // ── AI output parsing (never throws) ─────────────────────

  /**
   * Parse the coach's JSON and coerce each entry into a well-typed
   * CharacterFlag. Invalid issue types are dropped; a flag with no line AND no
   * reason is dropped. NEVER throws — malformed/empty output yields [].
   */
  private parseFlags(text: string): CharacterFlag[] {
    const parsed = this.safeParseJson(text);
    if (!parsed) return [];

    const rawList = Array.isArray(parsed?.flags)
      ? parsed.flags
      : Array.isArray(parsed)
        ? parsed
        : [];

    const out: CharacterFlag[] = [];
    for (const item of rawList) {
      const flag = this.normalizeFlag(item);
      if (flag) out.push(flag);
    }
    return out;
  }

  private normalizeFlag(item: any): CharacterFlag | null {
    if (!item || typeof item !== 'object') return null;
    const line = typeof item.line === 'string' ? item.line.trim() : '';
    const rawIssue = String(item.issue ?? '').toLowerCase().trim();
    // Drop flags whose issue isn't one of the three known kinds — a persona
    // agent that invents a category isn't producing an actionable flag.
    if (!VALID_ISSUES.has(rawIssue)) return null;
    const issue = rawIssue as CharacterFlagIssue;
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';

    // A usable flag needs the offending line AND some reason. Without the line
    // the author can't locate it; without a reason it isn't defensible.
    if (!line || !reason) return null;

    return { line, issue, reason, suggestion };
  }

  /**
   * Robust JSON recovery mirroring ContradictionDetector.safeParseJson
   * (fences → first-opener/last-closer slice → common-fix pass → truncation
   * recovery). Self-contained; returns null on total failure (never throws).
   */
  private safeParseJson(text: string): any | null {
    if (!text || !text.trim()) return null;

    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    const open = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
    if (open < 0) return null;

    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);

    if (end > open) {
      const candidate = cleaned.substring(open, end + 1);
      const p = this.tryParse(candidate);
      if (p !== undefined) return p;
    }

    const recovered = this.recoverTruncatedJson(cleaned.substring(open));
    if (recovered) {
      const p = this.tryParse(recovered);
      if (p !== undefined) return p;
    }

    return null;
  }

  private tryParse(candidate: string): any | undefined {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
    try {
      const fixed = candidate
        .replace(/,\s*([}\]])/g, '$1') // trailing commas
        .replace(/:\s*'([^']*)'/g, ': "$1"'); // single → double quotes on values
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort close of a truncated JSON string: walk tracking string context +
   * brace/bracket depth, trim to the last complete array element, and reclose.
   * Salvages the common max_tokens-cut-off case.
   */
  private recoverTruncatedJson(s: string): string | null {
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    let inString = false;
    let escape = false;
    const stack: string[] = [];
    let lastSafeComma = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
      else if (c === ',' && stack.length >= 1 && stack[stack.length - 1] === '[') {
        lastSafeComma = i;
      }
    }
    if (stack.length === 0 && !inString) return s;

    let truncated = s;
    if (lastSafeComma > 0) {
      truncated = s.substring(0, lastSafeComma);
      const newStack: string[] = [];
      let inStr = false;
      let esc = false;
      for (const c of truncated) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') newStack.push(c);
        else if (c === '}' || c === ']') newStack.pop();
      }
      while (newStack.length > 0) {
        const openCh = newStack.pop()!;
        truncated += openCh === '{' ? '}' : ']';
      }
      return truncated;
    }

    let recovery = s;
    if (inString) recovery += '"';
    while (stack.length > 0) {
      const openCh = stack.pop()!;
      recovery += openCh === '{' ? '}' : ']';
    }
    return recovery;
  }
}

// ── Small formatting helpers (module-local) ────────────────

function round(n: number): number {
  return Math.round((Number(n) || 0) * 10) / 10;
}
function pct(n: number): string {
  return `${Math.round((Number(n) || 0))}%`;
}
