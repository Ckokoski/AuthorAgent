---
name: cover-designer
description: Generate a complete book cover set (ebook, print, audiobook, social) with a rich visual brief
author: AuthorClaw
version: 1.0.0
triggers:
  - design my cover
  - make a book cover
  - generate book cover
  - cover for my book
  - create cover art
  - cover set
  - book cover variants
  - audiobook cover
  - kindle cover
permissions:
  - file_write
  - image_generation
---

# Cover Designer

Generate a coordinated set of book covers in the standard sizes an author
needs to ship across every retail platform — all from one visual brief, so
the ebook, print, audiobook, and social-banner versions look cohesive.

## Sizes produced

| Variant | Dimensions | What it's for |
|---|---|---|
| **Ebook** | 1024×1536 (2:3) | Amazon Kindle / KDP listings, BookBub thumbnails, Goodreads |
| **Print** | 1024×1536 (2:3) | Front cover for paperback / hardcover (6×9 trim). Spine + back wrap added separately in your designer. |
| **Audiobook** | 1024×1024 (1:1) | ACX / Findaway / Spotify. Upscale to 2400×2400 before submitting. |
| **Social** | 1536×1024 (3:2) | Twitter / X cards, Facebook OG, BookBub feature graphics, newsletter headers |

## How the AI brief works

Every cover gets the same set of fields, but the AI lays out for the
target aspect (vertical for ebook/print, square for audiobook, landscape
for social).

Required:
- `title` — the book title
- `author` — pen name (auto-pulled from linked persona if available)
- `genre` — primary genre (romance / fantasy / sci-fi / thriller / mystery / horror / literary / YA / nonfiction / memoir / children)
- `description` — what the book is about (the AI captures the *feeling*, not the literal scene)

Optional richness (use as many as fit your project):
- `subgenre` — e.g., "dark academia", "cosy mystery", "epic fantasy"
- `mood` — e.g., "tense, claustrophobic", "warm, hopeful"
- `era` — e.g., "1920s Vienna", "near-future", "Regency"
- `setting` — e.g., "ancient library at midnight", "remote Scottish cottage"
- `keyImagery` — array of visual elements you want featured (e.g., `["a burning compass", "raven feathers"]`)
- `palette` — color direction (e.g., "deep blue and gold", "blood red on charcoal")
- `avoidImagery` — what to keep OUT (e.g., "no faces, no weapons, no skulls")
- `style` — `realistic` | `illustrated` | `minimalist` (default: illustrated)

## Provider preference

By default uses **OpenAI's gpt-image-1** (best for book covers per author
testing). Falls back to **Together AI Flux** if no OpenAI key is configured.
Override with `provider: 'together' | 'openai' | 'auto'`.

## Quality vs. cost

`quality: 'high' | 'medium' | 'low' | 'auto'` (default `'high'` for covers).
Full set at high quality: ~$0.92. At medium: ~$0.46. At low: ~$0.23.

## Triggering this skill

Say things like:
- "Design a cover set for my project"
- "Make me a book cover"
- "Generate cover variants for [title]"
- "I need an audiobook cover"

The AI will gather the brief from your project metadata, ask clarifying
questions for any missing rich fields, then call `/api/projects/:id/cover-set`
and surface the generated images in the dashboard's Library panel.

## Title + author rendering

**Text is rendered ON the cover by default.** gpt-image-1 produces sharp,
genre-appropriate typography for book covers, so authors usually want a
finished cover they can list with — not a base image they have to typeset.

For ebook + print variants the title appears prominently (top half) and
the author name smaller near the bottom. Audiobook squares and social
banners are still rendered without on-image text because those formats
are typically re-typeset by the platform / overlay tool.

Override defaults:
- `includeText: false` → clean image, no on-cover text. Use this when you
  want to drop the image into your own designer (Canva, Photoshop, KDP
  Cover Creator, BookBrush, etc.) and add typography yourself.
- `typographyNote: "..."` → steer typography style. e.g.,
  `"hand-lettered serif, gold foil effect"` or `"bold sans-serif, all caps"`.

## Other important rules

- The AI brief is a *feeling*, not a literal scene. Saying "the sphere is
  glowing on the altar" works better than "exact angle showing the sphere".
- Even with text rendering on, double-check letterforms — sometimes the
  model produces near-misses. If a letter looks off, regenerate or set
  `includeText: false` and typeset in post.

## Where to expand

If you want a richer cover-prompt library (per-genre prompt templates,
trending-cover analysis, comp-cover matching), look at the **Writing
Secrets Ko-Fi store** — that's where the more specialized cover tooling
lives.
