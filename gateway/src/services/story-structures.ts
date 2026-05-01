/**
 * AuthorClaw Story Structures
 *
 * SMART-RECOMMEND, NOT FORCE. Different genres genuinely need different
 * structures (Save the Cat works for thrillers, fails for romance; Romancing
 * the Beat works for romance, fails for mystery). Some literary work
 * deliberately breaks structure for effect. Forcing one beat sheet on every
 * book produces formulaic output that authors and readers can both feel.
 *
 * What this service does:
 *   1. Catalogs proven story structures with metadata about which genres
 *      they fit best
 *   2. Given a project's genre + subgenre + premise (and optionally a draft
 *      outline), recommends the 1-3 most appropriate structures with
 *      explicit rationale — and offers "no structure / custom" as a first-
 *      class option
 *   3. Once the author picks (or opts out), runs a beat-checker on the
 *      outline that flags missing or misplaced beats AS SUGGESTIONS, not
 *      hard failures. Author can override anything they call deliberate.
 *
 * What this service does NOT do:
 *   - Auto-rewrite outlines without author approval
 *   - Block project progression on missing beats
 *   - Pretend that genre conventions are universal laws
 */

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type StructureId =
  | 'save_the_cat'
  | 'three_act'
  | 'five_act'
  | 'seven_point'
  | 'heros_journey'
  | 'romancing_the_beat'
  | 'story_circle'
  | 'mystery_5_stage'
  | 'martell_thematic'
  | 'none';

export interface Beat {
  /** Short label, e.g. "Opening Image" or "Catalyst". */
  name: string;
  /** Expected position as a percentage of the manuscript (0-100). */
  expectedPct: number;
  /** Acceptable position range (a beat at 28% might still count for "B Story"). */
  pctRange: [number, number];
  /** Plain-English description of what this beat is. */
  description: string;
  /** Keywords / phrases that often signal this beat in an outline summary. */
  keywords: string[];
  /** "Must have" beats are flagged louder if missing; "soft" beats are noted as suggestions. */
  mustHave: boolean;
}

export interface StoryStructure {
  id: StructureId;
  name: string;
  /** One-sentence summary used in the recommendation rationale. */
  oneLiner: string;
  /** Genres this structure fits best. */
  recommendedFor: string[];
  /** Genres this structure typically does NOT fit. */
  worksLessWellFor: string[];
  /** When to consider DESPITE the genre — e.g., literary romance might pick three_act over romancing_the_beat. */
  alsoConsiderWhen?: string;
  beats: Beat[];
  /** A sentence the recommender can show to explain why this structure exists. */
  why: string;
}

export interface BeatCheckResult {
  beat: Beat;
  /** Where in the outline the beat appears, as % of total. null = not detected. */
  foundAtPct: number | null;
  /** Confidence the detection is real (0-1). */
  confidence: number;
  /** "found_in_range" | "found_misplaced" | "missing" */
  status: 'found_in_range' | 'found_misplaced' | 'missing';
  /** Author-readable suggestion. */
  suggestion: string;
}

export interface OutlineCheckReport {
  structureId: StructureId;
  structureName: string;
  totalBeats: number;
  beatsFoundInRange: number;
  beatsFoundMisplaced: number;
  beatsMissing: number;
  /** Soft warnings vs. structural alarms. */
  mustHaveMissing: number;
  results: BeatCheckResult[];
  /** Overall narrative — author-friendly summary. */
  summary: string;
  /** True only if `mustHave` beats are missing OR multiple beats are out of range. */
  needsAttention: boolean;
}

export interface StructureRecommendation {
  recommended: Array<{
    structureId: StructureId;
    structureName: string;
    fitScore: number;       // 0-1 — how well it fits
    rationale: string;      // why this for this project
  }>;
  /** Additional advice beyond just structure choice. */
  additionalNotes: string[];
}

// ═══════════════════════════════════════════════════════════
// Built-in structures
// ═══════════════════════════════════════════════════════════

const STRUCTURES: StoryStructure[] = [
  {
    id: 'save_the_cat',
    name: 'Save the Cat (15 beats)',
    oneLiner: 'Blake Snyder\'s commercial-fiction beat sheet. Workhorse for thriller, mystery, action, women\'s fiction, and most genre fiction.',
    recommendedFor: ['thriller', 'mystery', 'sci-fi', 'fantasy', 'YA', 'commercial fiction', 'action', 'horror'],
    worksLessWellFor: ['romance', 'literary fiction', 'memoir', 'experimental'],
    alsoConsiderWhen: 'Most commercial genre books. Best when the protagonist has a clear external goal and faces escalating stakes.',
    why: 'Reverse-engineered from hundreds of bestselling commercial novels. Predictable in the best sense — readers feel structurally satisfied even when they don\'t consciously notice the beats.',
    beats: [
      { name: 'Opening Image', expectedPct: 1, pctRange: [0, 3], description: 'Snapshot of the protagonist\'s "before" world.', keywords: ['opens', 'beginning', 'introduction', 'starting'], mustHave: true },
      { name: 'Theme Stated', expectedPct: 5, pctRange: [3, 10], description: 'Theme spoken (often by a side character) — the truth the protagonist will learn.', keywords: ['theme', 'lesson', 'truth', 'message'], mustHave: false },
      { name: 'Set-Up', expectedPct: 10, pctRange: [5, 15], description: 'Protagonist\'s ordinary world, what\'s missing, why something has to change.', keywords: ['ordinary', 'routine', 'lack', 'home'], mustHave: true },
      { name: 'Catalyst (Inciting Incident)', expectedPct: 12, pctRange: [10, 18], description: 'The thing that disrupts the protagonist\'s status quo.', keywords: ['inciting', 'incident', 'news', 'attack', 'discovery', 'arrival', 'death'], mustHave: true },
      { name: 'Debate', expectedPct: 17, pctRange: [12, 22], description: 'Protagonist hesitates: should they go forward?', keywords: ['debate', 'decide', 'hesitate', 'doubt'], mustHave: false },
      { name: 'Break Into Two', expectedPct: 22, pctRange: [18, 28], description: 'Protagonist commits, leaves the ordinary world.', keywords: ['decide', 'leave', 'journey', 'enter', 'cross'], mustHave: true },
      { name: 'B Story', expectedPct: 30, pctRange: [25, 38], description: 'Subplot or relationship that carries the theme.', keywords: ['meet', 'relationship', 'love interest', 'mentor', 'rival'], mustHave: false },
      { name: 'Fun and Games', expectedPct: 38, pctRange: [28, 50], description: 'The "promise of the premise" — what readers came for.', keywords: ['training', 'investigation', 'adventure', 'romance'], mustHave: true },
      { name: 'Midpoint', expectedPct: 50, pctRange: [45, 55], description: 'Major reversal — false victory or false defeat — that raises the stakes.', keywords: ['midpoint', 'reveal', 'twist', 'truth', 'shift'], mustHave: true },
      { name: 'Bad Guys Close In', expectedPct: 60, pctRange: [55, 70], description: 'Antagonist\'s pressure mounts; allies splinter.', keywords: ['threat', 'pressure', 'attack', 'betrayal'], mustHave: true },
      { name: 'All Is Lost', expectedPct: 75, pctRange: [70, 80], description: 'The lowest point — protagonist\'s plan fails or someone dies.', keywords: ['lost', 'defeat', 'death', 'failure', 'rock bottom'], mustHave: true },
      { name: 'Dark Night of the Soul', expectedPct: 80, pctRange: [75, 85], description: 'Protagonist confronts their truth; learns the theme.', keywords: ['despair', 'realize', 'recognize', 'accept'], mustHave: true },
      { name: 'Break Into Three', expectedPct: 82, pctRange: [78, 88], description: 'Protagonist re-engages, armed with their new understanding.', keywords: ['return', 'plan', 'rise', 'go back'], mustHave: false },
      { name: 'Finale', expectedPct: 95, pctRange: [85, 98], description: 'Climactic confrontation — protagonist defeats the antagonist using what they learned.', keywords: ['climax', 'final', 'confront', 'defeat', 'battle'], mustHave: true },
      { name: 'Final Image', expectedPct: 99, pctRange: [97, 100], description: 'Mirror of the opening — the new world.', keywords: ['ending', 'closing', 'resolution', 'after'], mustHave: false },
    ],
  },
  {
    id: 'three_act',
    name: 'Three-Act Structure',
    oneLiner: 'The flexible default. Setup → Confrontation → Resolution with two big turning points.',
    recommendedFor: ['literary fiction', 'memoir', 'historical fiction', 'general fiction', 'short story'],
    worksLessWellFor: ['romance', 'cozy mystery'],
    alsoConsiderWhen: 'When Save the Cat feels too prescriptive. Three-act gives the same momentum without the 15-beat checklist.',
    why: 'Aristotle through Hollywood — the bones of nearly every story humans tell. Less prescriptive than Save the Cat; the four turning points are non-negotiable, but everything else is flexible.',
    beats: [
      { name: 'Hook / Opening', expectedPct: 1, pctRange: [0, 5], description: 'A reason to keep reading.', keywords: ['opens', 'begins', 'starts'], mustHave: true },
      { name: 'Inciting Incident', expectedPct: 12, pctRange: [8, 20], description: 'The disruption that starts the story.', keywords: ['inciting', 'incident', 'news', 'arrival', 'event'], mustHave: true },
      { name: 'First Plot Point', expectedPct: 25, pctRange: [20, 30], description: 'Protagonist crosses into Act 2 — the journey is on.', keywords: ['decide', 'commit', 'enter', 'cross'], mustHave: true },
      { name: 'Midpoint Reversal', expectedPct: 50, pctRange: [45, 55], description: 'Big shift in stakes, knowledge, or alliances.', keywords: ['midpoint', 'reveal', 'twist', 'shift'], mustHave: true },
      { name: 'Second Plot Point', expectedPct: 75, pctRange: [70, 80], description: 'Final piece falls into place — protagonist now has what they need to confront the climax.', keywords: ['realize', 'discover', 'understand', 'plan'], mustHave: true },
      { name: 'Climax', expectedPct: 90, pctRange: [85, 95], description: 'Direct confrontation between protagonist and central conflict.', keywords: ['climax', 'final', 'confront', 'battle', 'face'], mustHave: true },
      { name: 'Resolution', expectedPct: 98, pctRange: [95, 100], description: 'New normal.', keywords: ['ending', 'resolution', 'after', 'aftermath'], mustHave: true },
    ],
  },
  {
    id: 'five_act',
    name: 'Five-Act Structure (Freytag\'s Pyramid)',
    oneLiner: 'Exposition → Rising Action → Climax → Falling Action → Dénouement. The classic stage-drama and literary-tragedy structure.',
    recommendedFor: ['literary fiction', 'tragedy', 'historical fiction', 'stage drama adaptation', 'period drama', 'family saga'],
    worksLessWellFor: ['romance', 'thriller', 'cozy mystery'],
    alsoConsiderWhen: 'When the story has substantial falling action and aftermath — character-driven literary work where the climax happens earlier and the consequences carry the back third.',
    why: 'Gustav Freytag\'s 1863 analysis of classical drama. Distinct from three-act in that the climax sits at the centerpoint (around 50%), with substantial "falling action" and dénouement on the back half. Useful when the cost / aftermath of the climax is what the book is actually about.',
    beats: [
      { name: 'Exposition', expectedPct: 5, pctRange: [0, 15], description: 'Introduce protagonist, world, and the dramatic question.', keywords: ['opens', 'introduce', 'world', 'home'], mustHave: true },
      { name: 'Inciting Force', expectedPct: 15, pctRange: [10, 25], description: 'The disturbance that propels the story.', keywords: ['inciting', 'incident', 'disrupt', 'arrive'], mustHave: true },
      { name: 'Rising Action', expectedPct: 35, pctRange: [20, 50], description: 'Complications mount; protagonist commits more deeply.', keywords: ['complication', 'pursue', 'escalate', 'oppose'], mustHave: true },
      { name: 'Climax', expectedPct: 50, pctRange: [45, 60], description: 'The turning point — a choice, confrontation, or revelation that changes the trajectory.', keywords: ['climax', 'confront', 'reveal', 'decision', 'choice'], mustHave: true },
      { name: 'Falling Action', expectedPct: 70, pctRange: [55, 85], description: 'Consequences of the climax play out; tension drains as the new reality settles.', keywords: ['consequence', 'aftermath', 'fall', 'unravel'], mustHave: true },
      { name: 'Dénouement / Resolution', expectedPct: 95, pctRange: [85, 100], description: 'The new normal; threads tied off; meaning crystalizes.', keywords: ['ending', 'resolution', 'after', 'final'], mustHave: true },
    ],
  },
  {
    id: 'seven_point',
    name: 'Seven-Point Story Structure (Dan Wells)',
    oneLiner: 'Hook → Plot Turn 1 → Pinch 1 → Midpoint → Pinch 2 → Plot Turn 2 → Resolution. Cleaner than Save the Cat, designed for genre fiction.',
    recommendedFor: ['genre fiction', 'fantasy', 'sci-fi', 'thriller', 'YA', 'urban fantasy', 'space opera'],
    worksLessWellFor: ['memoir', 'experimental literary'],
    alsoConsiderWhen: 'When Save the Cat\'s 15 beats feel over-prescribed but you still want explicit turning points. Especially good for plotting BACKWARD — Wells\' method is to write the resolution first, then plot turn 2, etc.',
    why: 'Dan Wells\' framework (popularized in his Storymakers podcast). Two "plot turns" + two "pinches" + a midpoint give you five forced turning points across the manuscript — enough structure to keep momentum, fewer beats to game. Especially loved by genre-fiction plotters.',
    beats: [
      { name: 'Hook', expectedPct: 1, pctRange: [0, 5], description: 'The protagonist\'s starting state — the OPPOSITE of where they\'ll end up.', keywords: ['opens', 'beginning', 'starting'], mustHave: true },
      { name: 'Plot Turn 1', expectedPct: 25, pctRange: [20, 30], description: 'The disruption that sets the protagonist on the path of the story.', keywords: ['turn', 'disrupt', 'inciting', 'change'], mustHave: true },
      { name: 'Pinch Point 1', expectedPct: 38, pctRange: [33, 45], description: 'Antagonist applies pressure — protagonist learns the stakes are real.', keywords: ['pressure', 'attack', 'threat', 'pinch'], mustHave: true },
      { name: 'Midpoint', expectedPct: 50, pctRange: [45, 55], description: 'A revelation or decision that flips the story\'s direction. Protagonist shifts from reactive to proactive.', keywords: ['midpoint', 'reveal', 'shift', 'turn'], mustHave: true },
      { name: 'Pinch Point 2', expectedPct: 62, pctRange: [58, 70], description: 'Bigger, harder pressure — often someone close is lost or betrayed.', keywords: ['loss', 'betrayal', 'fail', 'pinch'], mustHave: true },
      { name: 'Plot Turn 2', expectedPct: 75, pctRange: [70, 82], description: 'The protagonist gets the final piece they need to confront the antagonist.', keywords: ['discover', 'realize', 'understand', 'turn'], mustHave: true },
      { name: 'Resolution', expectedPct: 95, pctRange: [85, 100], description: 'Climax + new state. The protagonist is the OPPOSITE of who they were at the Hook.', keywords: ['climax', 'resolution', 'end', 'final'], mustHave: true },
    ],
  },
  {
    id: 'heros_journey',
    name: 'The Hero\'s Journey (simplified, 12 stages)',
    oneLiner: 'Joseph Campbell\'s monomyth. Best for fantasy, myth, epic, and coming-of-age stories where the hero physically OR metaphorically leaves home.',
    recommendedFor: ['epic fantasy', 'high fantasy', 'mythology retelling', 'space opera', 'coming of age', 'YA fantasy', 'adventure'],
    worksLessWellFor: ['domestic fiction', 'romance', 'mystery', 'memoir'],
    alsoConsiderWhen: 'Stories where the protagonist undergoes a profound transformation through trials in an unfamiliar world.',
    why: 'Campbell\'s framework (popularized by Vogler) maps remarkably well onto adventure-quest fiction. Don\'t use it for stories where the protagonist never leaves home.',
    beats: [
      { name: 'Ordinary World', expectedPct: 5, pctRange: [0, 10], description: 'Hero in their normal life.', keywords: ['ordinary', 'home', 'before', 'routine'], mustHave: true },
      { name: 'Call to Adventure', expectedPct: 12, pctRange: [8, 18], description: 'Disruption that demands a response.', keywords: ['call', 'invitation', 'summons', 'task'], mustHave: true },
      { name: 'Refusal of the Call', expectedPct: 17, pctRange: [12, 22], description: 'Hero hesitates — fear or duty pulls them back.', keywords: ['refuse', 'hesitate', 'doubt', 'reluctant'], mustHave: false },
      { name: 'Meeting the Mentor', expectedPct: 22, pctRange: [17, 28], description: 'Wise figure provides guidance, gift, or knowledge.', keywords: ['mentor', 'teacher', 'guide', 'wisdom'], mustHave: false },
      { name: 'Crossing the Threshold', expectedPct: 25, pctRange: [22, 32], description: 'Hero leaves the ordinary world.', keywords: ['cross', 'leave', 'enter', 'depart'], mustHave: true },
      { name: 'Tests, Allies, Enemies', expectedPct: 40, pctRange: [30, 50], description: 'Hero learns the rules of the new world; gathers companions and adversaries.', keywords: ['test', 'ally', 'enemy', 'training', 'companion'], mustHave: true },
      { name: 'Approach to the Inmost Cave', expectedPct: 50, pctRange: [45, 60], description: 'Preparation for the central ordeal.', keywords: ['approach', 'prepare', 'enter'], mustHave: false },
      { name: 'The Ordeal', expectedPct: 60, pctRange: [55, 70], description: 'The hero faces death (literal or symbolic) and is reborn.', keywords: ['ordeal', 'death', 'sacrifice', 'crisis'], mustHave: true },
      { name: 'Reward (Seizing the Sword)', expectedPct: 70, pctRange: [65, 78], description: 'Hero claims what they came for — knowledge, object, power.', keywords: ['reward', 'claim', 'seize', 'obtain'], mustHave: false },
      { name: 'The Road Back', expectedPct: 80, pctRange: [75, 85], description: 'Hero returns toward the ordinary world; antagonist gives chase.', keywords: ['return', 'pursue', 'chase'], mustHave: false },
      { name: 'Resurrection', expectedPct: 90, pctRange: [85, 95], description: 'Final test — hero proves their transformation.', keywords: ['resurrection', 'final', 'climax', 'confront'], mustHave: true },
      { name: 'Return with the Elixir', expectedPct: 98, pctRange: [95, 100], description: 'Hero returns home transformed, sharing what they\'ve gained.', keywords: ['return', 'home', 'share', 'gift'], mustHave: true },
    ],
  },
  {
    id: 'romancing_the_beat',
    name: 'Romancing the Beat (Gwen Hayes — 10 beats)',
    oneLiner: 'Romance-specific beat sheet. Don\'t use Save the Cat for romance — emotional beats matter more than external plot.',
    recommendedFor: ['romance', 'romantic comedy', 'romantasy', 'contemporary romance', 'historical romance', 'paranormal romance'],
    worksLessWellFor: ['thriller', 'mystery', 'literary fiction', 'memoir'],
    why: 'Romance readers buy emotional satisfaction first, plot second. Romancing the Beat tracks the emotional rhythm of the central relationship — meet, attraction, conflict, breakup, reunion — which is what readers come back for.',
    beats: [
      { name: 'Introduce the Hero/ine', expectedPct: 3, pctRange: [0, 8], description: 'Establish the POV character\'s emotional wound + current state.', keywords: ['introduce', 'opens', 'protagonist'], mustHave: true },
      { name: 'Meet Cute', expectedPct: 8, pctRange: [5, 15], description: 'First on-page interaction with the love interest.', keywords: ['meet', 'first encounter', 'collide', 'introduce'], mustHave: true },
      { name: 'No Way! Awareness', expectedPct: 18, pctRange: [12, 25], description: 'Spark — they notice each other in a way that signals trouble.', keywords: ['notice', 'attraction', 'aware', 'spark'], mustHave: true },
      { name: 'Adhesion / Forced Proximity', expectedPct: 25, pctRange: [20, 35], description: 'They\'re thrown together by circumstance; can\'t escape each other.', keywords: ['stuck', 'together', 'paired', 'forced'], mustHave: true },
      { name: 'Deepening Desire', expectedPct: 40, pctRange: [30, 50], description: 'Emotional and physical chemistry deepens; vulnerability builds.', keywords: ['kiss', 'desire', 'longing', 'vulnerable'], mustHave: true },
      { name: 'Midpoint of Love', expectedPct: 50, pctRange: [45, 55], description: 'Big emotional moment — real intimacy, but stakes also rise.', keywords: ['intimate', 'love', 'commit', 'declaration'], mustHave: true },
      { name: 'Inevitable Doom', expectedPct: 65, pctRange: [55, 72], description: 'Internal conflict surfaces; doubt creeps in.', keywords: ['doubt', 'doom', 'fear', 'conflict'], mustHave: true },
      { name: 'Dark Moment / Breakup', expectedPct: 75, pctRange: [70, 80], description: 'They split — the relationship looks impossible.', keywords: ['breakup', 'leave', 'lost', 'separate', 'goodbye'], mustHave: true },
      { name: 'Grand Gesture / Crawling Back', expectedPct: 90, pctRange: [85, 95], description: 'One or both prove they\'ve changed and want this.', keywords: ['gesture', 'apologize', 'return', 'fight for'], mustHave: true },
      { name: 'Happily Ever After / For Now', expectedPct: 99, pctRange: [95, 100], description: 'Romance reader\'s reward — emotional payoff.', keywords: ['HEA', 'HFN', 'together', 'happy ending'], mustHave: true },
    ],
  },
  {
    id: 'story_circle',
    name: 'Dan Harmon\'s Story Circle (8 stages)',
    oneLiner: 'Tighter than the Hero\'s Journey, character-driven. Built for episodic storytelling but works for novels.',
    recommendedFor: ['character-driven fiction', 'literary fiction', 'sci-fi novella', 'short stories', 'episodic'],
    worksLessWellFor: ['epic fantasy', 'romance', 'thriller'],
    alsoConsiderWhen: 'Want the structural rhythm of the hero\'s journey without the mythic baggage.',
    why: 'Distills hero-myth structure to its load-bearing pieces: character WANTS something, GOES somewhere, gets what they wanted at a CHANGE, then returns CHANGED.',
    beats: [
      { name: 'You (Comfort Zone)', expectedPct: 5, pctRange: [0, 12], description: 'Character in their familiar situation.', keywords: ['ordinary', 'comfortable', 'before'], mustHave: true },
      { name: 'Need (Desire)', expectedPct: 15, pctRange: [10, 22], description: 'They want something.', keywords: ['want', 'need', 'desire', 'wish'], mustHave: true },
      { name: 'Go (Cross threshold)', expectedPct: 25, pctRange: [20, 32], description: 'They enter an unfamiliar situation in pursuit.', keywords: ['leave', 'enter', 'cross', 'depart'], mustHave: true },
      { name: 'Search (Adapt)', expectedPct: 40, pctRange: [30, 50], description: 'They struggle to adapt.', keywords: ['struggle', 'try', 'fail', 'adapt'], mustHave: true },
      { name: 'Find (Get what they want)', expectedPct: 55, pctRange: [45, 65], description: 'They get what they came for…', keywords: ['find', 'achieve', 'obtain', 'discover'], mustHave: true },
      { name: 'Take (Pay the price)', expectedPct: 70, pctRange: [60, 80], description: '…but it costs them something.', keywords: ['cost', 'price', 'sacrifice', 'lose'], mustHave: true },
      { name: 'Return (Cross back)', expectedPct: 85, pctRange: [78, 92], description: 'They return to the familiar situation.', keywords: ['return', 'back', 'home'], mustHave: true },
      { name: 'Change (Newly capable)', expectedPct: 98, pctRange: [92, 100], description: 'Changed by the experience.', keywords: ['change', 'transformed', 'different', 'new'], mustHave: true },
    ],
  },
  {
    id: 'mystery_5_stage',
    name: 'Mystery / Detective 5-Stage Structure',
    oneLiner: 'Setup → Investigation → Complications → False Solution → True Solution. Designed for clue placement, suspect introduction, and the "everyone\'s a suspect" turn.',
    recommendedFor: ['mystery', 'cozy mystery', 'detective', 'whodunit', 'noir', 'crime fiction'],
    worksLessWellFor: ['romance', 'fantasy', 'literary fiction'],
    why: 'Mystery readers are essentially detectives reading along. The structure must support clue placement and red herrings; generic three-act doesn\'t do that. Clues planted in the wrong stage feel cheap or arbitrary.',
    beats: [
      { name: 'The Crime / Disturbance', expectedPct: 5, pctRange: [0, 12], description: 'The mystery is established — body found, theft discovered, etc.', keywords: ['crime', 'body', 'death', 'disturbance', 'discover'], mustHave: true },
      { name: 'Detective Engaged', expectedPct: 12, pctRange: [8, 20], description: 'The investigator commits to solving it.', keywords: ['investigator', 'detective', 'case', 'engaged'], mustHave: true },
      { name: 'Suspects Introduced', expectedPct: 25, pctRange: [18, 35], description: 'The pool of possible culprits is established.', keywords: ['suspect', 'introduce', 'meet'], mustHave: true },
      { name: 'First Major Clue', expectedPct: 35, pctRange: [25, 45], description: 'A discovery that reshapes the investigation.', keywords: ['clue', 'evidence', 'find', 'reveal'], mustHave: true },
      { name: 'Red Herring / False Lead', expectedPct: 50, pctRange: [40, 60], description: 'Detective pursues the wrong suspect / wrong theory.', keywords: ['red herring', 'false', 'wrong', 'misled'], mustHave: false },
      { name: 'Stakes Raised (Second Crime)', expectedPct: 60, pctRange: [50, 70], description: 'Antagonist strikes again or the danger grows.', keywords: ['second', 'another', 'attack', 'kill'], mustHave: true },
      { name: 'False Solution', expectedPct: 75, pctRange: [70, 80], description: 'The wrong suspect is "caught" or accused — and the case looks closed.', keywords: ['arrest', 'caught', 'closed', 'wrong'], mustHave: false },
      { name: 'The Realization', expectedPct: 82, pctRange: [78, 88], description: 'Detective sees what they missed.', keywords: ['realize', 'recognize', 'understand', 'piece'], mustHave: true },
      { name: 'Confrontation / True Reveal', expectedPct: 92, pctRange: [88, 96], description: 'The real culprit is unmasked.', keywords: ['reveal', 'confront', 'expose', 'truth'], mustHave: true },
      { name: 'Resolution', expectedPct: 98, pctRange: [95, 100], description: 'Justice / consequence / new normal.', keywords: ['resolution', 'justice', 'aftermath'], mustHave: true },
    ],
  },
  {
    id: 'martell_thematic',
    name: 'Martell Thematic Approach (theme-as-spine)',
    oneLiner: 'William C. Martell\'s framework: THEME is the spine; protagonist embodies a flawed worldview, antagonist embodies the opposite extreme, climax forces a synthesis. Every scene tested against theme.',
    recommendedFor: ['literary thriller', 'character-driven fiction', 'crime fiction', 'screenplay-adjacent novels', 'psychological thriller', 'noir', 'literary fiction with hooks'],
    worksLessWellFor: ['plot-puzzle mystery', 'cozy fiction', 'pure adventure'],
    alsoConsiderWhen: 'When you can answer "what is this story ARGUING about life?" in one sentence. If you can\'t, this approach won\'t help you yet — pick a beat sheet and find the theme later.',
    why: 'William C. Martell (screenwriting blog at Scriptsecrets.net, "The Secrets of Action Screenwriting") teaches that theme is the SPINE every scene hangs from. Protagonist starts with a flawed worldview that has worked for them but is incomplete. Antagonist is not "evil" — they\'re the opposite extreme of the same thematic question, taken to a destructive end. The climax forces the protagonist to confront, reject the false binary, and synthesize. Useful when "plot" alone feels mechanical — gives every scene a reason to exist.',
    beats: [
      { name: 'Theme Statement (Implicit)', expectedPct: 5, pctRange: [0, 10], description: 'Opening establishes the thematic question — usually as a contradiction in the protagonist\'s starting beliefs or behavior.', keywords: ['theme', 'belief', 'contradiction', 'flaw'], mustHave: true },
      { name: 'Protagonist\'s Flawed Worldview', expectedPct: 10, pctRange: [5, 18], description: 'Show the protagonist\'s thematic stance in action — and why it has worked for them so far.', keywords: ['ordinary', 'belief', 'pattern', 'comfort', 'routine'], mustHave: true },
      { name: 'Antagonist Introduction (Opposite Extreme)', expectedPct: 18, pctRange: [12, 30], description: 'Antagonist embodies the opposite thematic position, taken to a destructive end. Their worldview is a mirror, not a foreign concept.', keywords: ['antagonist', 'opposite', 'enemy', 'rival'], mustHave: true },
      { name: 'Thematic Test 1', expectedPct: 30, pctRange: [22, 40], description: 'Protagonist\'s flawed worldview is challenged — they double down because it has always worked.', keywords: ['challenge', 'test', 'doubt', 'resist'], mustHave: true },
      { name: 'False Synthesis (Midpoint)', expectedPct: 50, pctRange: [42, 58], description: 'Protagonist appears to evolve thematically, but they\'re still operating from their flawed frame. Often a partial victory that exposes a deeper problem.', keywords: ['midpoint', 'reveal', 'shift', 'partial'], mustHave: true },
      { name: 'Thematic Test 2 (Painful)', expectedPct: 65, pctRange: [55, 75], description: 'Bigger challenge that the protagonist\'s old worldview can\'t handle. Costs them dearly.', keywords: ['cost', 'loss', 'fail', 'pain'], mustHave: true },
      { name: 'Thematic Crisis', expectedPct: 78, pctRange: [70, 85], description: 'The dark night of the soul — protagonist sees that BOTH their old worldview and the antagonist\'s extreme are wrong.', keywords: ['crisis', 'realize', 'collapse', 'truth'], mustHave: true },
      { name: 'Synthesis (Climax)', expectedPct: 90, pctRange: [85, 95], description: 'Protagonist forges a third path that rejects the false binary. Defeats antagonist using the integrated truth.', keywords: ['synthesis', 'integrate', 'climax', 'transform'], mustHave: true },
      { name: 'Theme Confirmed', expectedPct: 98, pctRange: [95, 100], description: 'The new state — the thematic argument is paid off. The protagonist embodies the synthesis.', keywords: ['ending', 'transformed', 'new', 'confirm'], mustHave: true },
    ],
  },
  {
    id: 'none',
    name: 'No Structure / Author\'s Choice',
    oneLiner: 'Skip beat enforcement entirely — for experimental work, literary fiction, or when the author wants full creative control.',
    recommendedFor: ['experimental fiction', 'literary fiction', 'memoir', 'short story collection', 'unconventional narratives'],
    worksLessWellFor: ['commercial genre fiction (you risk an unsatisfying read)'],
    why: 'Some books earn the right to break structure for effect. Authors writing experimental, mosaic, or character-study fiction may legitimately not want any structural enforcement.',
    beats: [],
  },
];

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class StoryStructureService {
  /** List all available structures + their metadata. */
  list(): StoryStructure[] {
    return STRUCTURES;
  }

  get(id: StructureId): StoryStructure | null {
    return STRUCTURES.find(s => s.id === id) || null;
  }

  /**
   * Recommend 1-3 structures for a given project.
   *
   * Pure heuristic — no AI calls. Scores each structure by genre fit and
   * surfaces explicit rationale. The author decides; the recommender just
   * narrows the field. We always include "none" as an explicit option for
   * literary/experimental work.
   */
  recommend(input: {
    genre: string;
    subgenre?: string;
    description?: string;
  }): StructureRecommendation {
    const genreLower = (input.genre || '').toLowerCase().trim();
    const subgenreLower = (input.subgenre || '').toLowerCase().trim();
    const descLower = (input.description || '').toLowerCase();
    const additionalNotes: string[] = [];

    const scored = STRUCTURES
      .filter(s => s.id !== 'none') // 'none' is always offered separately
      .map(s => {
        let score = 0;
        const reasons: string[] = [];

        // Strong genre match (+0.6)
        const genreMatch = s.recommendedFor.some(g =>
          genreLower.includes(g.toLowerCase()) || g.toLowerCase().includes(genreLower) ||
          subgenreLower.includes(g.toLowerCase()) || g.toLowerCase().includes(subgenreLower)
        );
        if (genreMatch) {
          score += 0.6;
          reasons.push(`built for ${input.subgenre || input.genre}`);
        }

        // Penalty for "works less well for"
        const worksLessWell = s.worksLessWellFor.some(g =>
          genreLower.includes(g.toLowerCase()) ||
          subgenreLower.includes(g.toLowerCase())
        );
        if (worksLessWell) {
          score -= 0.4;
          reasons.push(`historically a poor fit for ${input.subgenre || input.genre}`);
        }

        // Description-based heuristics (small boost)
        if (descLower) {
          if (s.id === 'heros_journey' && /(quest|journey|chosen|prophecy|mentor|destiny)/.test(descLower)) {
            score += 0.15;
            reasons.push('description mentions quest/journey/destiny themes');
          }
          if (s.id === 'mystery_5_stage' && /(crime|murder|detective|investigation|missing|stolen|killed|body)/.test(descLower)) {
            score += 0.15;
            reasons.push('description signals crime/investigation');
          }
          if (s.id === 'romancing_the_beat' && /(love|romance|relationship|attraction|couple|chemistry)/.test(descLower)) {
            score += 0.15;
            reasons.push('description signals romantic plot');
          }
          if (s.id === 'three_act' && /(family|coming of age|memoir|grief|literary)/.test(descLower)) {
            score += 0.1;
            reasons.push('description suggests character-driven narrative');
          }
          if (s.id === 'five_act' && /(tragedy|aftermath|fall|consequence|saga|generational|period drama)/.test(descLower)) {
            score += 0.15;
            reasons.push('description signals tragedy / extensive aftermath');
          }
          if (s.id === 'seven_point' && /(genre|epic|adventure|chosen one|rebellion)/.test(descLower)) {
            score += 0.1;
            reasons.push('clean turning-point structure suits the genre');
          }
          if (s.id === 'martell_thematic' && /(theme|argument|moral|worldview|belief|contradiction|flaw)/.test(descLower)) {
            score += 0.2;
            reasons.push('description foregrounds a thematic argument');
          }
        }

        return {
          structureId: s.id,
          structureName: s.name,
          fitScore: Math.max(0, Math.min(1, score)),
          rationale: reasons.length > 0
            ? `${s.oneLiner} — ${reasons.join('; ')}.`
            : s.oneLiner,
        };
      })
      .filter(r => r.fitScore > 0.2) // drop clearly-bad fits
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 3);

    // If literary / experimental signals, surface "none" prominently
    if (/(literary|experimental|memoir|essay|mosaic|fragment)/i.test(genreLower + ' ' + subgenreLower + ' ' + descLower)) {
      const noneStruct = STRUCTURES.find(s => s.id === 'none')!;
      additionalNotes.push(
        `For ${input.subgenre || input.genre}, "${noneStruct.name}" is also a legitimate choice. ` +
        `Many literary novels deliberately break structure for effect. AuthorClaw won't force a beat sheet you didn't pick.`
      );
    }

    if (scored.length === 0) {
      additionalNotes.unshift(
        `No strong genre match found. The Three-Act Structure is a flexible default that fits most stories; ` +
        `or pick "No Structure / Author's Choice" if you're writing something deliberately unstructured.`
      );
      // Surface three_act + none as fallback
      const threeAct = STRUCTURES.find(s => s.id === 'three_act')!;
      scored.push({
        structureId: 'three_act',
        structureName: threeAct.name,
        fitScore: 0.5,
        rationale: threeAct.oneLiner,
      });
    }

    return { recommended: scored, additionalNotes };
  }

  /**
   * Check an outline against a chosen structure. Returns SUGGESTIONS, not
   * hard failures. Author can override anything they call deliberate.
   *
   * The outline is an array of chapter summaries (strings). We treat each
   * chapter as roughly equal width and search for beat keywords + check
   * whether they appear in the expected position range.
   */
  checkOutline(outline: string[], structureId: StructureId): OutlineCheckReport | null {
    const structure = this.get(structureId);
    if (!structure) return null;
    if (structure.id === 'none' || structure.beats.length === 0) {
      return {
        structureId, structureName: structure.name,
        totalBeats: 0, beatsFoundInRange: 0, beatsFoundMisplaced: 0, beatsMissing: 0,
        mustHaveMissing: 0, results: [],
        summary: `No structure selected — beat checking skipped. AuthorClaw won't enforce structure on this project.`,
        needsAttention: false,
      };
    }
    if (outline.length === 0) {
      return {
        structureId, structureName: structure.name,
        totalBeats: structure.beats.length, beatsFoundInRange: 0,
        beatsFoundMisplaced: 0, beatsMissing: structure.beats.length,
        mustHaveMissing: structure.beats.filter(b => b.mustHave).length,
        results: [],
        summary: `Outline is empty.`,
        needsAttention: true,
      };
    }

    const total = outline.length;
    const results: BeatCheckResult[] = [];

    for (const beat of structure.beats) {
      // Score each chapter for beat keyword matches.
      let bestChapter = -1;
      let bestScore = 0;
      const beatKeywordsLower = beat.keywords.map(k => k.toLowerCase());
      for (let i = 0; i < total; i++) {
        const lower = outline[i].toLowerCase();
        let score = 0;
        for (const kw of beatKeywordsLower) {
          if (lower.includes(kw)) score += 1;
        }
        if (score > bestScore) { bestScore = score; bestChapter = i; }
      }

      const confidence = Math.min(1, bestScore / Math.max(2, beat.keywords.length / 2));
      const foundAtPct = bestChapter >= 0 ? Math.round(((bestChapter + 0.5) / total) * 100) : null;

      let status: BeatCheckResult['status'] = 'missing';
      let suggestion = '';
      if (foundAtPct !== null && bestScore > 0) {
        const [low, high] = beat.pctRange;
        if (foundAtPct >= low && foundAtPct <= high) {
          status = 'found_in_range';
          suggestion = `✓ "${beat.name}" appears around chapter ${bestChapter + 1} (${foundAtPct}%) — within expected range.`;
        } else {
          status = 'found_misplaced';
          const direction = foundAtPct < low ? 'earlier than' : 'later than';
          suggestion =
            `"${beat.name}" appears ${direction} expected (found at chapter ${bestChapter + 1} = ${foundAtPct}%; expected around ${beat.expectedPct}%, range ${low}-${high}%). ` +
            `${beat.description} ` +
            `If this placement is intentional, ignore this. Otherwise, consider restructuring.`;
        }
      } else {
        suggestion = `"${beat.name}" not detected. ${beat.description} ` +
          `Consider whether this beat exists somewhere in the outline (perhaps phrased differently than the keywords ${beat.keywords.slice(0, 3).join(', ')}…), ` +
          `or whether you've intentionally chosen to omit it.`;
      }

      results.push({ beat, foundAtPct, confidence, status, suggestion });
    }

    const beatsFoundInRange = results.filter(r => r.status === 'found_in_range').length;
    const beatsFoundMisplaced = results.filter(r => r.status === 'found_misplaced').length;
    const beatsMissing = results.filter(r => r.status === 'missing').length;
    const mustHaveMissing = results.filter(r => r.status === 'missing' && r.beat.mustHave).length;

    const summary = `${beatsFoundInRange} of ${structure.beats.length} beats found in expected range. ` +
      (beatsFoundMisplaced > 0 ? `${beatsFoundMisplaced} appear placed unusually. ` : '') +
      (beatsMissing > 0 ? `${beatsMissing} not detected (${mustHaveMissing} must-have).` : '');

    const needsAttention = mustHaveMissing > 0 || beatsFoundMisplaced + beatsMissing > structure.beats.length / 3;

    return {
      structureId, structureName: structure.name,
      totalBeats: structure.beats.length,
      beatsFoundInRange, beatsFoundMisplaced, beatsMissing, mustHaveMissing,
      results, summary, needsAttention,
    };
  }
}
