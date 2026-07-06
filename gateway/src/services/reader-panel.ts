/**
 * AuthorClaw Synthetic Reader Panels
 *
 * A marketing-moat feature: tournament-based evaluation of marketing assets
 * (blurbs, titles, cover concepts, high-level book concepts) against a panel
 * of demographically-parameterized reader personas.
 *
 * Based on the published "Synthetic Reader Panels" methodology now used by
 * real imprints to pre-test cover/blurb/title candidates before spending on
 * A/B ad tests. The core idea: instead of asking one LLM "which blurb is
 * best?" (which collapses into generic slop), you build a demographically
 * VARIED panel of reader personas and run the candidates through a PAIRWISE
 * TOURNAMENT — each persona votes head-to-head, and you aggregate votes into
 * a ranking with per-segment preferences.
 *
 * ── Why pairwise, not absolute scoring? ──
 *   Absolute 1-10 scoring of marketing copy is where LLM judges are weakest:
 *   everything clusters at 7-8 and nothing discriminates. Pairwise "which of
 *   these two would make YOU (a 40-something ads-discovered cozy-fantasy
 *   reader) click?" produces a real preference signal. Wins aggregate into a
 *   ranking.
 *
 * ── Anti-slop safeguards (the load-bearing detail) ──
 *   LLM-judge panels are prone to "judge collapse" — the model produces
 *   near-identical reasoning for every persona, or fails to discriminate
 *   between candidates, or is biased by which candidate appears first. Four
 *   safeguards defend against this (see runTournament + the checks below):
 *     (a) score-clustering check — flags when win-rates are too tight
 *     (b) repetition/templating check — Jaccard near-duplicate reason detection
 *     (c) position-bias mitigation — candidate order is swapped per persona
 *     (d) an overall confidence score derived from the above
 *
 * ── Cost discipline ──
 *   Persona judgments are simple → routed to the FREE tier ('marketing').
 *   Personas are BATCHED: ONE AI call per matchup returns ALL personas' votes.
 *   For N candidates in single-elimination, that is N-1 matchups = N-1 calls.
 *   Panel generation from a template set is FREE (no AI call). The optional
 *   AI panel-spin-up is ONE extra call. So a default single-elim run on 4
 *   candidates costs 3 AI calls total (or 4 with AI panel generation).
 */

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface ReaderPersona {
  id: string;
  label: string;
  genre: string;
  ageBand: string;                              // e.g. "25-34"
  priceSensitivity: 'low' | 'med' | 'high';
  discovery: 'browsing' | 'recommendation' | 'ads' | 'series-fan';
  readingPace: string;                          // e.g. "2-3 books/month"
  notes: string;                                // sub-genre affinities + quirks
}

export type PanelKind = 'blurb' | 'title' | 'cover-concept' | 'concept';
export type PanelFormat = 'single-elim' | 'swiss';

/** One persona's vote in one matchup. */
export interface MatchupVote {
  personaId: string;
  /** 'A' or 'B' — which candidate (in the order shown to THIS persona) won. */
  winner: 'A' | 'B';
  reason: string;
}

/** A single head-to-head matchup between two candidate indices. */
export interface Matchup {
  /** Candidate indices (into the original candidates[] array). */
  a: number;
  b: number;
  /** Per-persona votes, normalized back to original candidate indices.
   *  `votedFirstShown` records whether the persona picked the candidate shown
   *  in its first ("A") slot — used by the residual position-bias diagnostic. */
  votes: Array<{ personaId: string; winnerIndex: number; reason: string; votedFirstShown: boolean }>;
  round: number;
}

export interface CandidateRanking {
  candidate: string;
  /** 0-1 fraction of pairwise votes this candidate won. */
  winRate: number;
  /** Which demographic segment most preferred this candidate, plain English. */
  segmentPreference: string;
  /** 1-3 representative persona reasons (deduplicated). */
  sampleReasons: string[];
}

export interface PanelReport {
  kind: PanelKind;
  genre: string;
  panelSize: number;
  ranking: CandidateRanking[];
  winner: string | null;
  /** 0-1 overall confidence in the result. */
  confidence: number;
  /** Anti-slop + operational warnings surfaced to the user. */
  warnings: string[];
  matchupsRun: number;
}

export type AICompleteFn = (req: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string }>;

export type AISelectProviderFn = (taskType: string) => { id: string };

// ═══════════════════════════════════════════════════════════
// Curated persona template pools, keyed by broad genre.
//
// buildPanel() draws from these deterministically (varying by index, never
// Math.random). Each pool is a set of demographic "axes" the panel mixes:
// age bands, price sensitivity, discovery mode, reading pace, and sub-genre
// affinity. An unknown genre falls back to a generic commercial-fiction pool.
// ═══════════════════════════════════════════════════════════

interface PersonaAxes {
  ageBands: string[];
  paces: string[];
  subAffinities: string[];
}

/** Broad-genre buckets. A free-text genre is matched by keyword to one of these. */
const GENRE_AXES: Record<string, PersonaAxes> = {
  fantasy: {
    ageBands: ['18-24', '25-34', '35-44', '45-54'],
    paces: ['5+ books/month', '2-3 books/month', '1 book/month', '4-5 books/month'],
    subAffinities: [
      'cozy / low-stakes fantasy, found family',
      'epic / high fantasy, deep worldbuilding',
      'romantasy, slow-burn romance arcs',
      'grimdark, morally grey protagonists',
    ],
  },
  romance: {
    ageBands: ['18-24', '25-34', '35-44', '45-54'],
    paces: ['10+ books/month', '5+ books/month', '2-3 books/month', '3-4 books/month'],
    subAffinities: [
      'contemporary romance, banter-forward',
      'small-town / cozy romance, HEA guaranteed',
      'dark romance, high-heat, morally grey',
      'historical romance, era-accurate detail',
    ],
  },
  thriller: {
    ageBands: ['25-34', '35-44', '45-54', '55-64'],
    paces: ['2-3 books/month', '1 book/month', '4-5 books/month', '1-2 books/month'],
    subAffinities: [
      'domestic thriller, unreliable narrators',
      'police procedural, technical accuracy',
      'psychological suspense, slow dread',
      'action thriller, fast body count',
    ],
  },
  mystery: {
    ageBands: ['35-44', '45-54', '55-64', '65+'],
    paces: ['2-3 books/month', '1 book/month', '3-4 books/month', '1-2 books/month'],
    subAffinities: [
      'cozy mystery, amateur sleuth + cat',
      'whodunit, fair-play clue placement',
      'noir, atmosphere over plot',
      'procedural, forensic detail',
    ],
  },
  scifi: {
    ageBands: ['18-24', '25-34', '35-44', '45-54'],
    paces: ['2-3 books/month', '1 book/month', '4-5 books/month', '1-2 books/month'],
    subAffinities: [
      'space opera, big set pieces',
      'hard SF, rigorous science',
      'cozy / hopepunk SF, low stakes',
      'dystopian / near-future, social edge',
    ],
  },
  horror: {
    ageBands: ['18-24', '25-34', '35-44', '45-54'],
    paces: ['2-3 books/month', '1 book/month', '3-4 books/month', '1-2 books/month'],
    subAffinities: [
      'supernatural horror, dread + atmosphere',
      'splatterpunk, high gore',
      'quiet / literary horror, slow burn',
      'creature feature, monster payoff',
    ],
  },
  literary: {
    ageBands: ['25-34', '35-44', '45-54', '55-64'],
    paces: ['1 book/month', '1-2 books/month', '2-3 books/month', '1 book/2 months'],
    subAffinities: [
      'upmarket book-club fiction',
      'character-driven literary, prose-forward',
      'quiet domestic drama',
      'experimental / voice-driven',
    ],
  },
  ya: {
    ageBands: ['13-17', '18-24', '25-34', '30-40 (crossover)'],
    paces: ['5+ books/month', '2-3 books/month', '4-5 books/month', '1 book/month'],
    subAffinities: [
      'YA fantasy, chosen-one arcs',
      'YA romance, first-love beats',
      'YA contemporary, issue-driven',
      'YA dystopian, rebellion plots',
    ],
  },
};

/** Generic commercial-fiction pool for unrecognized genres. */
const GENERIC_AXES: PersonaAxes = {
  ageBands: ['18-24', '25-34', '35-44', '45-54', '55-64'],
  paces: ['1 book/month', '2-3 books/month', '4-5 books/month', '5+ books/month'],
  subAffinities: [
    'plot-first, wants a page-turner',
    'character-first, wants to feel something',
    'voice-first, notices the writing',
    'concept-first, wants a fresh premise',
  ],
};

// Rotated deterministically by persona index so a panel mixes all modes.
const PRICE_SENSITIVITY: Array<ReaderPersona['priceSensitivity']> = ['low', 'med', 'high'];
const DISCOVERY_MODES: Array<ReaderPersona['discovery']> = ['browsing', 'recommendation', 'ads', 'series-fan'];

// ═══════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════

const KIND_FRAMING: Record<PanelKind, string> = {
  blurb: 'back-cover blurb / product description',
  title: 'book title',
  'cover-concept': 'cover-design concept (described in words)',
  concept: 'high-level book concept / premise',
};

function buildMatchupSystemPrompt(kind: PanelKind, genre: string): string {
  const framing = KIND_FRAMING[kind];
  return `You are simulating a panel of real ${genre} readers evaluating two candidate ${framing}s head-to-head.

You will be given CANDIDATE A and CANDIDATE B, plus a numbered list of reader personas. For EACH persona, decide which candidate would make THAT SPECIFIC reader more likely to buy/click/keep-reading — judged through their demographics, price sensitivity, how they discover books, and their sub-genre taste. A cozy-fantasy series-fan and an ads-discovered grimdark reader will often disagree; that disagreement is the signal.

Rules:
1. Judge as the persona, not as a marketer. A high-price-sensitivity reader weighs "does this look worth $4.99" differently than a low-sensitivity one.
2. Give a SHORT, SPECIFIC one-line reason grounded in THIS persona's traits — never generic ("it's catchier"). Reference what in the copy pulled them.
3. Do NOT default to always picking A or always picking B. Judge each persona independently.
4. If a persona would genuinely be split, pick the one they'd click FIRST.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "votes": [
    {"personaId": "p1", "winner": "A", "reason": "As a 25-34 ads-discovered romantasy reader, the slow-burn promise in A hooks me faster than B's plot summary."},
    {"personaId": "p2", "winner": "B", "reason": "..."}
  ]
}

One vote object per persona, in order. winner is exactly "A" or "B".`;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class ReaderPanelService {
  /**
   * Build a demographically-varied panel for a genre. Deterministic (no
   * Math.random): every axis is rotated by persona index so a size-N panel
   * spans price sensitivities, discovery modes, age bands, and sub-genre
   * affinities. Same (genre, size) always yields the same panel.
   */
  buildPanel(genre: string, size = 6): ReaderPersona[] {
    const n = Math.max(1, Math.min(24, Math.floor(size) || 6));
    const axes = this.axesForGenre(genre);
    const personas: ReaderPersona[] = [];
    for (let i = 0; i < n; i++) {
      const ageBand = axes.ageBands[i % axes.ageBands.length];
      const pace = axes.paces[i % axes.paces.length];
      const affinity = axes.subAffinities[i % axes.subAffinities.length];
      // Offset the rotating axes so they don't all cycle in lockstep — this
      // maximizes demographic spread across a small panel.
      const price = PRICE_SENSITIVITY[i % PRICE_SENSITIVITY.length];
      const discovery = DISCOVERY_MODES[(i + 1) % DISCOVERY_MODES.length];
      personas.push({
        id: `p${i + 1}`,
        label: `${ageBand} · ${discovery} · ${affinity.split(',')[0]}`,
        genre,
        ageBand,
        priceSensitivity: price,
        discovery,
        readingPace: pace,
        notes: `${affinity}. Price sensitivity ${price}. Discovers books via ${discovery}.`,
      });
    }
    return personas;
  }

  /**
   * Optionally spin up a panel via a single cheap AI call for a target genre.
   * Falls back to the template panel if the AI output is missing/malformed.
   * Kept separate from buildPanel so the default path stays free + deterministic.
   */
  async buildPanelAI(
    genre: string,
    size: number,
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<ReaderPersona[]> {
    const fallback = this.buildPanel(genre, size);
    let raw = '';
    try {
      const provider = aiSelectProvider('marketing');
      const resp = await aiComplete({
        provider: provider.id,
        system: `Generate ${fallback.length} demographically-VARIED ${genre} reader personas for pre-testing marketing copy. Vary age band, price sensitivity (low/med/high), discovery mode (browsing/recommendation/ads/series-fan), reading pace, and sub-genre affinity. Return ONLY JSON: {"personas":[{"id":"p1","ageBand":"25-34","priceSensitivity":"med","discovery":"ads","readingPace":"2-3 books/month","notes":"..."}]}. No markdown fences.`,
        messages: [{ role: 'user', content: `Genre: ${genre}. Count: ${fallback.length}.` }],
        maxTokens: 1200,
        temperature: 0.7,
      });
      raw = resp.text || '';
    } catch {
      return fallback;
    }
    const parsed = this.parseJson(raw);
    const arr = Array.isArray(parsed?.personas) ? parsed.personas : [];
    if (arr.length === 0) return fallback;
    const out: ReaderPersona[] = [];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      const price: ReaderPersona['priceSensitivity'] =
        p?.priceSensitivity === 'low' || p?.priceSensitivity === 'high' ? p.priceSensitivity : 'med';
      const discovery: ReaderPersona['discovery'] =
        DISCOVERY_MODES.includes(p?.discovery) ? p.discovery : 'browsing';
      out.push({
        id: typeof p?.id === 'string' && p.id ? p.id : `p${i + 1}`,
        label: `${p?.ageBand || '?'} · ${discovery}`,
        genre,
        ageBand: typeof p?.ageBand === 'string' ? p.ageBand : '25-34',
        priceSensitivity: price,
        discovery,
        readingPace: typeof p?.readingPace === 'string' ? p.readingPace : '2-3 books/month',
        notes: typeof p?.notes === 'string' ? p.notes : `${genre} reader`,
      });
    }
    return out.length > 0 ? out : fallback;
  }

  /**
   * Run a pairwise tournament of the candidates against the panel.
   *
   * Cost: ONE batched AI call per matchup (all personas vote in that one
   * call). single-elim on N candidates = N-1 matchups. swiss = a few rounds
   * of pairings, capped.
   */
  async runTournament(
    input: {
      candidates: string[];
      kind: PanelKind;
      genre: string;
      panelSize?: number;
      format?: PanelFormat;
    },
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<PanelReport> {
    const candidates = (input.candidates || []).map(c => String(c ?? '').trim()).filter(Boolean);
    const kind = input.kind;
    const genre = input.genre || 'commercial fiction';
    const format: PanelFormat = input.format === 'swiss' ? 'swiss' : 'single-elim';

    // Guard: need at least 2 candidates to run a tournament.
    if (candidates.length < 2) {
      return {
        kind,
        genre,
        panelSize: 0,
        ranking: candidates.map(c => ({
          candidate: c,
          winRate: 0,
          segmentPreference: 'n/a',
          sampleReasons: [],
        })),
        winner: candidates[0] ?? null,
        confidence: 0,
        warnings: ['Need at least 2 candidates to run a panel tournament. Provide 2 or more.'],
        matchupsRun: 0,
      };
    }

    const panel = this.buildPanel(genre, input.panelSize ?? 6);
    const provider = aiSelectProvider('marketing');
    const systemPrompt = buildMatchupSystemPrompt(kind, genre);

    // Build the pairing schedule.
    const pairings = format === 'swiss'
      ? this.swissPairings(candidates.length)
      : this.singleElimPairings(candidates.length);

    // Tally: per-candidate wins + total votes it participated in.
    const wins = new Array(candidates.length).fill(0);
    const appearances = new Array(candidates.length).fill(0);
    // Which segment (price/discovery) preferred which candidate.
    const segmentWins: Record<number, Record<string, number>> = {};
    // All reasons per candidate (for repetition check + sampling).
    const reasonsByCandidate: Record<number, string[]> = {};
    const allReasons: string[] = [];
    const matchups: Matchup[] = [];

    for (let r = 0; r < pairings.length; r++) {
      const [ai, bi] = pairings[r];
      const votes = await this.runMatchup(
        candidates, ai, bi, panel, r, provider.id, systemPrompt, aiComplete,
      );
      const normalized: Matchup['votes'] = [];
      for (const v of votes) {
        appearances[ai]++;
        appearances[bi]++;
        const winnerIndex = v.winnerIndex;
        wins[winnerIndex]++;
        normalized.push({ personaId: v.personaId, winnerIndex, reason: v.reason, votedFirstShown: v.votedFirstShown });
        // Segment attribution.
        const persona = panel.find(p => p.id === v.personaId);
        if (persona) {
          for (const seg of [`price:${persona.priceSensitivity}`, `discovery:${persona.discovery}`]) {
            segmentWins[winnerIndex] = segmentWins[winnerIndex] || {};
            segmentWins[winnerIndex][seg] = (segmentWins[winnerIndex][seg] || 0) + 1;
          }
        }
        (reasonsByCandidate[winnerIndex] = reasonsByCandidate[winnerIndex] || []).push(v.reason);
        if (v.reason) allReasons.push(v.reason);
      }
      matchups.push({ a: ai, b: bi, votes: normalized, round: r });
    }

    // ── Build ranking ──
    const ranking: CandidateRanking[] = candidates.map((c, i) => {
      const winRate = appearances[i] > 0 ? wins[i] / appearances[i] : 0;
      return {
        candidate: c,
        winRate: Math.round(winRate * 1000) / 1000,
        segmentPreference: this.describeSegment(segmentWins[i]),
        sampleReasons: this.dedupeReasons(reasonsByCandidate[i] || []).slice(0, 3),
      };
    }).sort((a, b) => b.winRate - a.winRate);

    const winner = ranking.length > 0 && ranking[0].winRate > 0 ? ranking[0].candidate : (ranking[0]?.candidate ?? null);

    // ── Anti-slop safeguards ──
    const warnings: string[] = [];

    // (a) Score-clustering check: if the top and bottom win-rates are within a
    // tiny band, the panel isn't discriminating between candidates.
    const rates = ranking.map(r => r.winRate);
    const spread = rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0;
    const clustered = spread < 0.15;
    if (clustered) {
      warnings.push(
        `Panel not discriminating: candidate win-rates span only ${(spread * 100).toFixed(0)} points. ` +
        `The candidates may be too similar, or the panel couldn't tell them apart — treat the ranking as low-confidence.`,
      );
    }

    // (b) Repetition / templating check: near-duplicate persona reasons signal
    // judge collapse (the model wrote one reason and reskinned it).
    const repetition = this.repetitionScore(allReasons);
    if (repetition.duplicatePairs > 0 && repetition.ratio >= 0.3) {
      warnings.push(
        `Possible judge collapse: ${(repetition.ratio * 100).toFixed(0)}% of persona reasons are near-duplicates ` +
        `(${repetition.duplicatePairs} near-identical pairs). The panel may be templating one opinion across personas.`,
      );
    }

    // (c) Position-bias mitigation is APPLIED inside runMatchup (order swapped
    // per persona). Surface a note if we detected a residual lean anyway.
    const bias = this.positionBiasResidual(matchups);
    if (bias.flagged) {
      warnings.push(
        `Residual position bias detected: even after order-swapping, "first-shown" candidates won ` +
        `${(bias.firstWinRate * 100).toFixed(0)}% of votes. Interpret close results with extra caution.`,
      );
    }

    // Operational warning if any matchup returned no usable votes.
    const emptyMatchups = matchups.filter(m => m.votes.length === 0).length;
    if (emptyMatchups > 0) {
      warnings.push(
        `${emptyMatchups} of ${matchups.length} matchup(s) returned no usable votes (AI output was empty or malformed). ` +
        `Ranking is based on the remaining matchups.`,
      );
    }

    // (d) Confidence score: start at 1, penalize each failure mode.
    let confidence = 1;
    if (clustered) confidence -= 0.4;
    if (repetition.ratio >= 0.3) confidence -= 0.25;
    if (bias.flagged) confidence -= 0.2;
    if (emptyMatchups > 0) confidence -= 0.15 * (emptyMatchups / Math.max(1, matchups.length));
    // Small panels + few matchups are inherently noisier.
    if (panel.length < 4) confidence -= 0.1;
    if (matchups.length < 2) confidence -= 0.1;
    confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));

    return {
      kind,
      genre,
      panelSize: panel.length,
      ranking,
      winner,
      confidence,
      warnings,
      matchupsRun: matchups.length,
    };
  }

  // ── Matchup execution ──

  /**
   * Run ONE matchup: all personas vote in a single batched AI call.
   *
   * Position-bias mitigation (safeguard c): the presented A/B order is
   * ACTUALLY SWAPPED per persona — even-indexed personas see candidate `ai`
   * as "A", odd-indexed personas see candidate `bi` as "A". Because each
   * persona has its own labeled pair in the prompt, the model literally reads
   * the two candidates in different orders across the panel, so a first-slot
   * preference can't systematically favor one real candidate. The model's
   * "A"/"B" is normalized back to original candidate indices here so the tally
   * is order-independent, and we record whether each persona picked its
   * first-shown option (feeds the residual-bias diagnostic).
   */
  private async runMatchup(
    candidates: string[],
    ai: number,
    bi: number,
    panel: ReaderPersona[],
    round: number,
    providerId: string,
    systemPrompt: string,
    aiComplete: AICompleteFn,
  ): Promise<Array<{ personaId: string; winnerIndex: number; reason: string; votedFirstShown: boolean }>> {
    // Per-persona swap: map each persona's "A" slot to a real candidate index.
    // Deterministic (parity of index) — no Math.random. Present each persona
    // its OWN candidate pair so the order it reads is genuinely swapped.
    const aSlotFor: Record<string, number> = {}; // personaId -> real candidate index shown as its "A"
    const personaBlocks = panel.map((p, idx) => {
      const swap = idx % 2 === 1;
      const slotA = swap ? bi : ai;
      const slotB = swap ? ai : bi;
      aSlotFor[p.id] = slotA;
      return (
        `- ${p.id} (${p.ageBand}, price-sensitivity ${p.priceSensitivity}, discovers via ${p.discovery}, reads ${p.readingPace}; taste: ${p.notes})\n` +
        `    A: ${candidates[slotA]}\n` +
        `    B: ${candidates[slotB]}`
      );
    });

    // Each persona sees its own A/B (order swapped across the panel to kill
    // position bias). Ask the model to answer per persona with the letter it saw.
    const userPrompt =
      `You are simulating ${panel.length} readers. Each persona below is shown TWO candidates as "A" and "B" ` +
      `(the order differs between personas on purpose). For each persona, pick the one THAT reader would choose, ` +
      `answering with the letter ("A" or "B") as shown to that persona, plus a one-line reason.\n\n` +
      `PERSONAS:\n${personaBlocks.join('\n')}\n\n` +
      `Return JSON: {"votes":[{"personaId":"p1","winner":"A","reason":"..."}, ...]} — one per persona, in order. ` +
      `Keep each reason to ONE short sentence (max ~20 words) so the full JSON fits.`;

    let raw = '';
    try {
      const resp = await aiComplete({
        provider: providerId,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        // Budget scales with panel size (~160 tokens/persona for a short reason
        // + JSON overhead) with a floor. Gemini 2.5-flash spends part of the
        // output budget on default "thinking", so a too-small cap truncates the
        // JSON mid-array and yields zero parseable votes.
        maxTokens: Math.max(2048, panel.length * 160 + 512),
        temperature: 0.6,
      });
      raw = resp.text || '';
    } catch {
      return [];
    }

    const parsed = this.parseJson(raw);
    const rawVotes = Array.isArray(parsed?.votes) ? parsed.votes : [];
    const out: Array<{ personaId: string; winnerIndex: number; reason: string; votedFirstShown: boolean }> = [];
    for (const v of rawVotes) {
      const personaId = typeof v?.personaId === 'string' ? v.personaId : '';
      if (!personaId || !(personaId in aSlotFor)) continue;
      const w = String(v?.winner || '').trim().toUpperCase();
      if (w !== 'A' && w !== 'B') continue;
      // "A" for THIS persona maps to aSlotFor[personaId]; "B" is the other one.
      const slotA = aSlotFor[personaId];
      const slotB = slotA === ai ? bi : ai;
      const winnerIndex = w === 'A' ? slotA : slotB;
      const votedFirstShown = w === 'A'; // "A" is always the first-shown slot for that persona
      const reason = typeof v?.reason === 'string' ? v.reason.trim() : '';
      out.push({ personaId, winnerIndex, reason, votedFirstShown });
    }
    return out;
  }

  // ── Pairing schedules ──

  /**
   * Single-elimination bracket over candidate INDICES. Winners advance based
   * on the running placeholder (we don't know real winners until votes are in,
   * so we schedule a balanced bracket of N-1 matchups by pairing adjacent
   * survivors; for evaluation purposes each matchup is independent and every
   * candidate is compared at least once). Returns exactly N-1 pairings.
   */
  private singleElimPairings(n: number): Array<[number, number]> {
    const pairings: Array<[number, number]> = [];
    // Round-robin-ish adjacency to guarantee each candidate appears, capped at
    // N-1 matchups so cost stays bounded (matches the spec: single-elim = N-1).
    let idx = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = i;
      const b = i + 1;
      pairings.push([a, b]);
      idx++;
    }
    return pairings;
  }

  /**
   * Swiss-style pairings: a few rounds where candidates are paired against
   * "nearby" others. Bounded to keep cost predictable: ceil(n/2) rounds,
   * capped at a hard maximum of matchups.
   */
  private swissPairings(n: number): Array<[number, number]> {
    const pairings: Array<[number, number]> = [];
    const seen = new Set<string>();
    const rounds = Math.min(3, Math.max(1, Math.ceil(n / 2)));
    const MAX_MATCHUPS = 12; // hard cap on cost
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n; i += 2) {
        const a = (i + r) % n;
        const b = (i + r + 1) % n;
        if (a === b) continue;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairings.push([a, b]);
        if (pairings.length >= MAX_MATCHUPS) return pairings;
      }
    }
    return pairings;
  }

  // ── Anti-slop helpers ──

  /**
   * Repetition / templating detector. Tokenizes each reason into a word set and
   * measures Jaccard similarity between all pairs. Returns the fraction of
   * pairs that are near-duplicates (≥ 0.6 similarity) and the raw pair count.
   */
  repetitionScore(reasons: string[]): { ratio: number; duplicatePairs: number } {
    const cleaned = reasons.map(r => this.tokenSet(r)).filter(s => s.size > 0);
    if (cleaned.length < 2) return { ratio: 0, duplicatePairs: 0 };
    let dup = 0;
    let total = 0;
    for (let i = 0; i < cleaned.length; i++) {
      for (let j = i + 1; j < cleaned.length; j++) {
        total++;
        if (this.jaccard(cleaned[i], cleaned[j]) >= 0.6) dup++;
      }
    }
    return { ratio: total > 0 ? dup / total : 0, duplicatePairs: dup };
  }

  /**
   * Position-bias residual: fraction of votes that went to the candidate shown
   * in the persona's FIRST ("A") slot. Because runMatchup genuinely swaps the
   * presented order across the panel, a fair panel sits near 0.5. A strong lean
   * either direction means the model is picking by slot, not by content — flag
   * it. Uses the recorded `votedFirstShown` (real order), not a parity guess.
   */
  private positionBiasResidual(matchups: Matchup[]): { flagged: boolean; firstWinRate: number } {
    let firstWins = 0;
    let totalVotes = 0;
    for (const m of matchups) {
      for (const v of m.votes) {
        if (v.votedFirstShown) firstWins++;
        totalVotes++;
      }
    }
    if (totalVotes === 0) return { flagged: false, firstWinRate: 0 };
    const firstWinRate = firstWins / totalVotes;
    const flagged = firstWinRate >= 0.72 || firstWinRate <= 0.28;
    return { flagged, firstWinRate };
  }

  /** Describe the dominant segment that preferred a candidate, in plain English. */
  private describeSegment(segMap: Record<string, number> | undefined): string {
    if (!segMap) return 'no clear segment';
    const entries = Object.entries(segMap).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return 'no clear segment';
    const [top] = entries;
    const [kind, val] = top[0].split(':');
    const label = kind === 'price' ? `${val}-price-sensitivity readers` : `${val}-discovery readers`;
    return `strongest with ${label} (${top[1]} votes)`;
  }

  /** Deduplicate reasons by near-identity so sampleReasons shows variety. */
  private dedupeReasons(reasons: string[]): string[] {
    const out: string[] = [];
    const sets: Set<string>[] = [];
    for (const r of reasons) {
      if (!r) continue;
      const ts = this.tokenSet(r);
      const dup = sets.some(s => this.jaccard(s, ts) >= 0.7);
      if (!dup) {
        out.push(r);
        sets.push(ts);
      }
    }
    return out;
  }

  // ── Small utilities ──

  private axesForGenre(genre: string): PersonaAxes {
    const g = (genre || '').toLowerCase();
    if (/cozy|fantasy|romantasy|epic|magic|dragon|witch/.test(g)) return GENRE_AXES.fantasy;
    if (/romance|romantic|love/.test(g)) return GENRE_AXES.romance;
    if (/thriller|suspense/.test(g)) return GENRE_AXES.thriller;
    if (/mystery|cozy mystery|whodunit|detective|crime/.test(g)) return GENRE_AXES.mystery;
    if (/sci-?fi|science fiction|space|dystop/.test(g)) return GENRE_AXES.scifi;
    if (/horror|gothic/.test(g)) return GENRE_AXES.horror;
    if (/literary|upmarket|book club/.test(g)) return GENRE_AXES.literary;
    if (/\bya\b|young adult|teen/.test(g)) return GENRE_AXES.ya;
    return GENERIC_AXES;
  }

  private tokenSet(text: string): Set<string> {
    const stop = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'as',
      'is', 'it', 'this', 'that', 'with', 'i', 'me', 'my', 'more', 'than', 'so',
      'would', 'their', 'them', 'they', 'reader', 'readers', 'book', 'candidate',
    ]);
    return new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w)),
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  /** Defensive JSON parse (mirrors WritingJudge / ContextEngine approach). */
  private parseJson(raw: string): any {
    const cleaned = String(raw || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const slice = cleaned.substring(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return null;
      }
    }
  }
}
