---
name: nonfiction-research
description: Academic source gathering, citation management, fact-checking for nonfiction
author: AuthorAgent
version: 1.0.0
triggers:
  - "nonfiction"
  - "citation"
  - "cite"
  - "bibliography"
  - "source"
  - "academic"
  - "fact check"
  - "reference"
permissions:
  - network:http
  - file:read
  - file:write
---

# Nonfiction Research Skill

Comprehensive research support for nonfiction authors.

## Source Management
- Track all sources with full citation data
- Organize by chapter/topic
- Flag primary vs. secondary sources
- Note source reliability and potential bias

## Citation Formats
Support: APA, MLA, Chicago (Notes & Bibliography), Chicago (Author-Date), Harvard
Auto-generate bibliography/works cited in the author's preferred format.

## Fact-Checking Process
1. Identify all factual claims in the manuscript
2. Trace each claim to its source
3. Verify source reliability
4. Flag: ✅ verified, ⚠️ needs stronger source, ❌ cannot verify
5. Note claims that are author opinion vs. established fact

## Interview Management
- Track interview subjects, dates, and key quotes
- Permission/consent tracking
- Quote accuracy verification

## Data Visualization
- Help structure data for charts, graphs, and infographics
- Fact-check statistical claims
- Suggest better ways to present complex data

## Legal Awareness
- Flag potential libel concerns
- Note when something might need legal review
- Track permissions needed for quoted material
- Fair use considerations

## Output
Save research database to `projects/[project]/research/sources.md`
