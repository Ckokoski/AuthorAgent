---
name: ingest-tool
description: Read source code of any tool and generate an AuthorAgent skill from it
author: AuthorAgent
version: 1.0.0
triggers:
  - "ingest tool"
  - "create skill from"
  - "import tool"
  - "make a skill"
  - "convert to skill"
  - "read this code"
  - "analyze this tool"
permissions:
  - file:read
  - file:write
---

# Tool Ingestion — Code to Skill Converter

Read source code of any external tool and generate a proper AuthorAgent SKILL.md file.

## Process

1. **Read the source code** provided by the user (file path or pasted code)
2. **Analyze the tool**:
   - Purpose and domain (writing, formatting, marketing, analysis)
   - Inputs: arguments, config files, stdin
   - Outputs: files, stdout, formats
   - Language: Python, JavaScript, HTML, etc.
   - CLI interface and flags (if any)
   - Dependencies required
3. **Generate SKILL.md** with:
   - YAML frontmatter: name, description, triggers, permissions
   - How the tool works
   - Input/output documentation
   - Example commands or workflows
   - How AuthorAgent should invoke or reference it
4. **Save** to `skills/author/[tool-name]/SKILL.md` (or marketing/core as appropriate)

## SKILL.md Format

```yaml
---
name: tool-name-kebab-case
description: One-line description of what the tool does
author: AuthorAgent (generated from [original tool])
version: 1.0.0
triggers:
  - "keyword 1"
  - "keyword 2"
permissions:
  - file:read
  - file:write
---

# Tool Name

[How it works, when to use it, example commands]
```

## Rules

- NEVER invent capabilities the tool doesn't have
- Note required dependencies (Python version, npm packages)
- If the tool is GUI-only, note it requires manual interaction
- If the tool has a CLI, document exact command syntax
- Keep triggers practical — words users would actually type
- Name must be kebab-case, unique, and descriptive
