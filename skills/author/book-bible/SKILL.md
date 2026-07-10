---
name: book-bible
description: Maintain world consistency - characters, timeline, locations, rules, items
author: AuthorAgent
version: 1.0.0
triggers:
  - "book bible"
  - "character"
  - "character sheet"
  - "timeline"
  - "world building"
  - "world bible"
  - "consistency"
  - "continuity"
permissions:
  - file:read
  - file:write
---

# Book Bible Skill

Maintain a living reference document for the book's world. Every fact, character detail, and timeline event goes here so nothing contradicts itself.

## Book Bible Sections

### Characters
For each character track:
- **Name** (full, nicknames, aliases)
- **Physical**: Age, appearance, distinguishing features
- **Personality**: Core traits, flaws, quirks, speech patterns
- **Background**: History, education, occupation, family
- **Motivation**: What they want (surface), what they need (deep)
- **Arc**: How they change from beginning to end
- **Relationships**: Connections to other characters
- **Voice Notes**: How they talk differently from others
- **First Appearance**: Chapter/scene where introduced

### Timeline
- Chronological order of events (in-story time)
- Character ages at key events
- Season/weather tracking
- Day-of-week tracking (if relevant)
- Travel time between locations

### Locations
- Physical description
- Sensory details (sounds, smells, atmosphere)
- What happens there in the story
- Rules of the place
- Map references if applicable

### World Rules
- Magic system rules (fantasy)
- Technology constraints (sci-fi)
- Social structures and hierarchies
- Economic systems
- Legal/political systems
- What's possible and impossible

### Items & Objects
- Significant objects and their descriptions
- Where they are at any given time
- Symbolic meaning

## Consistency Checks
When the author writes new content, automatically check against the Book Bible:
- ✅ Character descriptions match
- ✅ Timeline events don't contradict
- ✅ Location details are consistent
- ✅ World rules aren't broken
- ⚠️ Flag any conflicts found

## Storage
Save to `workspace/memory/book-bible/[project-id]/`
