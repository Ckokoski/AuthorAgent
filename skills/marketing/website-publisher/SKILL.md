---
name: website-publisher
description: Manage your author website — auto-publish books on completion, draft blog posts from your projects, render and deploy with one command
author: AuthorClaw
version: 1.0.0
triggers:
  - publish my site
  - publish my website
  - update my website
  - update my site
  - deploy my website
  - deploy my site
  - render my site
  - render my website
  - draft a blog post
  - write a blog post
  - blog post about
  - announce my new book
  - new release post
  - behind the scenes post
  - excerpt post
  - teaser post
  - link site to project
  - register my site
  - set up my website
permissions:
  - file_write
  - shell_exec
---

# Website Publisher

The management layer on top of AuthorClaw's static-site builder. Generates
your site, keeps it in sync with your books, drafts blog posts from your
project artifacts, and pushes the rendered site to your host.

This skill is **deliberately not a CMS**. AuthorClaw is for producing books
— shipping a working site is part of that, but maintaining a fully
interactive web property isn't. Authors who need comments, forms, ESP
integration UIs, or deep analytics should keep using the WordPress /
Squarespace / Ghost they already have.

## What it does

### 1. Sites — register, link, manage

A "site" is a deployable unit (one author or one pen name typically). Each
site has:
  - A config (slug, name, tagline, base URL, primary color, social links)
  - A list of linked **projects** (when those projects complete, their
    books auto-publish to the site's books list)
  - A list of **blog posts** (drafts + published — drafted by this skill)
  - A **deploy target** (Netlify / Vercel / Cloudflare Pages / rsync /
    manual zip / none)

```
POST /api/sites           Create a site
GET  /api/sites           List all sites + freshness status
PATCH /api/sites/:id       Update config / linked projects / deploy target
DELETE /api/sites/:id      Remove a site
POST /api/sites/:id/link-project   { projectId }
```

### 2. Auto-add books on project completion

When a `book-production` or `novel-pipeline` project completes AND the
project is linked to one or more sites, the book is auto-added to each
site's books list. Idempotent on slug — re-completing the project updates
the existing entry.

The author **still has to render + deploy explicitly** — auto-publishing a
brand-new book without review would be too aggressive. The dashboard shows
each site's `pendingChanges` count so the author knows when a render is
needed.

### 3. Blog post drafter

Four post types, each pulling different project artifacts into a focused
prompt:

| Type | What it produces |
|------|------------------|
| `release_announcement` | New-release post: 500-700 words, conversational, with buy-link CTAs |
| `behind_the_scenes` | Process post: 700-900 words pulling from chapter summaries + user-model + craft-critic flags |
| `excerpt` | Excerpt-with-tease post: lead-in → verbatim scene → tease → CTA |
| `teaser` | Coming-soon post: 350-500 words building anticipation without overselling |

```
POST /api/blog-posts/draft
{
  "postType": "behind_the_scenes",
  "projectId": "project-12",
  "siteId": "my-pen-name-site",   // optional — auto-add to site's queue
  "authorAngle": "I want to talk about how I cut chapter 7 four times"
}
```

Drafts go to **pending review**. Author edits in the dashboard, then the
post is rendered + deployed with the next publish.

### 4. Render + deploy

```
POST /api/sites/:id/render    Re-render the static site files
POST /api/sites/:id/deploy    Push the rendered files to the host
POST /api/sites/:id/publish   Combined: render + deploy in one call
GET  /api/site-deploy/doctor  Probe which deploy CLIs are installed
```

Deploy adapters supported (each shells out to the host's CLI; we don't
bundle them):
  - **netlify** — `netlify deploy --prod` (requires `netlify-cli`)
  - **vercel** — `vercel deploy --prod` (requires `vercel`)
  - **cloudflare-pages** — `wrangler pages deploy` (requires `wrangler`)
  - **rsync** — push to your own server via SSH (requires `rsync`)
  - **manual-zip** — produces a ZIP file at `workspace/exports/website/`
    that you upload manually via your host's web UI. **The safe default.**
    Works on every host without auth setup.
  - **none** — render only, no deploy

Tokens are read from `process.env` at deploy time using a configured
`tokenEnvVar` name. **Tokens are never stored in AuthorClaw config.**

## What this skill does NOT do

- ❌ Not a CMS (no comments, forms, plugins, themes marketplace)
- ❌ Not an ESP integration (paste your own ConvertKit / MailerLite /
     Beehiiv embed code into the site config — already supported)
- ❌ Not an SEO settings panel (we already auto-emit sitemap.xml,
     RSS feed, and OG tags from your config)
- ❌ Not multi-tenant (local-first; one author's machine, their sites)
- ❌ Not a scheduling system (a future cron handler can do this; it's
     not built in v1)

## Recommended workflow

1. **Set up** — `POST /api/sites` once. Configure title, baseUrl, social
   links, deploy target.
2. **Link your projects** — `POST /api/sites/:id/link-project` for each
   book project you want featured on the site.
3. **Write your books** — when projects complete, books auto-add to the
   site's books list. Author sees `pendingChanges` increment.
4. **Draft blog posts** as new releases ship — release announcements,
   behind-the-scenes, excerpts, teasers.
5. **Publish** — `POST /api/sites/:id/publish` renders + deploys in one
   call. Or render and deploy separately for control.

## When to NOT use this skill

If you already have a working WordPress / Squarespace / Ghost / Wix site
that fits your workflow, AuthorClaw can still complement it (cover gen,
blog post drafts you paste into your CMS, etc.) — but you don't need this
skill. Use it when you want a clean static site that auto-syncs with your
AuthorClaw projects with minimal hosting cost ($0 on Netlify free tier
for most authors).
