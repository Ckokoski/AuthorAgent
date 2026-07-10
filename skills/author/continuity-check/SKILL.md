---
name: continuity-check
description: Scan manuscript for inconsistencies in characters, timeline, settings, and names
author: AuthorAgent
version: 1.0.0
triggers:
  - "continuity"
  - "continuity check"
  - "consistency check"
  - "find inconsistencies"
  - "timeline check"
  - "plot holes"
  - "check continuity"
permissions:
  - file:read
---

# Continuity Check Skill

Scan a manuscript (or set of chapters) for internal inconsistencies. This is not a style review — the goal is to catch factual contradictions within the text itself.

## What to Check

### 1. Character Consistency
- **Physical descriptions**: Eye color, hair, height, scars, tattoos — flag if described differently in two places.
- **Age and aging**: Does a character's stated age match the timeline? Do children age appropriately between scenes set years apart?
- **Abilities and limitations**: A character who can't swim in chapter 3 shouldn't be diving in chapter 12 without explanation.
- **Personality and knowledge**: Flag moments where a character suddenly knows something they shouldn't, or behaves in a way that contradicts established traits without narrative justification.
- **Relationships**: If two characters are introduced as strangers, they shouldn't reference shared history later (unless a reveal is intended).

### 2. Timeline and Chronology
- **Event order**: Do flashbacks, references to past events, and "three days later" markers add up?
- **Travel time**: If two cities are a week's ride apart, a character shouldn't arrive the next morning.
- **Day/night and seasons**: If a scene starts at dusk, it shouldn't be noon two paragraphs later without a time skip. Winter shouldn't become summer in a single chapter unless time passes.
- **Parallel scenes**: When cutting between storylines, do the timelines stay in sync?
- **Dates and ages**: Any specific dates, years, or stated ages must remain consistent throughout.

### 3. Setting and World Details
- **Geography**: A river that flows north in one chapter shouldn't flow south in another. Room layouts, building locations, and distances should stay fixed.
- **World rules**: If magic costs energy, characters shouldn't cast freely without consequence. Technology, physics, and social rules must stay consistent.
- **Named places**: Spelling and descriptions of locations should not change (e.g., "Thornfield Inn" vs "Thornfeld Inn").
- **Climate and environment**: Vegetation, weather patterns, and environmental details should match the established region.

### 4. Names and Terminology
- **Character names**: First names, surnames, nicknames, and titles must be spelled consistently. Flag any drift (e.g., "Katherine" in chapter 1 vs "Catherine" in chapter 8).
- **Place names**: Same rule — no unexplained spelling changes.
- **Invented terms**: Made-up words, species, technologies, or organizations should be spelled and capitalized the same way every time.
- **Titles and ranks**: If a character is a Captain, they shouldn't be called Lieutenant later without a demotion scene.

### 5. Plot Threads and Objects
- **Chekhov's guns**: Note significant objects or plot threads that are introduced but never resolved.
- **Resolved threads**: Flag threads that are resolved without adequate setup.
- **Object tracking**: If a character drops a sword in a fight, they shouldn't be holding it two scenes later without picking it up.
- **Information flow**: If a secret is revealed to Character A in chapter 5, other characters shouldn't know it in chapter 6 unless told on-page or plausibly off-page.

## Severity Levels

Categorize every finding into one of three levels:

### ERROR — Definite contradiction
Two statements in the manuscript directly contradict each other. The reader will notice.
> Example: "His green eyes narrowed" (ch. 2) vs "She looked into his brown eyes" (ch. 14)

### WARNING — Probable inconsistency
Something looks wrong but could be intentional. Needs the author's judgment.
> Example: A character who is terrified of heights willingly climbs a tower without internal conflict or acknowledgment.

### INFO — Worth verifying
A detail that appears only once and could cause problems later, or a minor drift that might be a typo.
> Example: A side character's name appears only twice, spelled slightly differently each time.

## Output Format

Organize findings by category. For each finding, include:

```
[ERROR|WARNING|INFO] Category — Short description
  Evidence: "exact quote" (Chapter X / location)
  Conflicts with: "exact quote" (Chapter Y / location)
  Suggestion: How to resolve the inconsistency
```

### Summary Section

After all findings, provide a summary:

```
Continuity Check Summary
========================
Errors:   X
Warnings: X
Info:     X

Most affected areas: [list the chapters or sections with the most issues]
```

## Guidelines

- **Quote the text.** Every finding must reference specific passages. Never say "somewhere in chapter 3" — give the actual line or paragraph.
- **Do not flag style choices.** A character behaving unexpectedly is not an error if the narrative frames it as surprising. Only flag contradictions, not creative decisions.
- **Check the Book Bible first.** If a Book Bible exists in `workspace/memory/book-bible/`, cross-reference it for established facts. If no Book Bible exists, build your reference from the manuscript text itself.
- **Work systematically.** Read through the manuscript tracking facts on the first pass, then scan for contradictions on the second. Do not try to do both at once.
- **Group related issues.** If the same character's name is misspelled five times, that is one finding with five instances, not five separate findings.
- **Be precise, not exhaustive.** Ten real issues are more useful than fifty maybes. When in doubt, use INFO level rather than WARNING.
