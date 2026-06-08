# Project State

Last updated: June 1, 2026

## Current focus

Tonight: scaffold the monorepo, write CLAUDE.md and docs, build the Scribe agent with paper ingestion and structured extraction, build the Office UI shell with four tabs (three greyed out).

## What is built

As of June 1, 2026:

- Monorepo scaffold complete (pnpm workspaces, apps/web, packages/core, packages/db, packages/agents/scribe)
- Next.js 16.2.7 App Router scaffolded in apps/web
- Drizzle ORM installed in packages/db (schema not yet defined)
- CLAUDE.md restructured into tiered format with most important rules first
- docs/lessons.md created as living document for accumulated learnings
- .claude/ directory with starter skills (adding-a-feature, reviewing-own-work, debugging) and notification hook
- Foundation verified

Known deviations from spec:
- pnpm invoked via corepack rather than global install
- pnpm-workspace.yaml includes allowBuilds block for pnpm 11 compatibility
- create-next-app added apps/web/AGENTS.md and apps/web/CLAUDE.md (left in place)

## What is next

- Database schema for papers, claims, authors, citations (next prompt)
- Wire up Drizzle client to a real Neon database
- Scribe ingestion pipeline (arXiv URL in, structured data stored)
- Scribe chat interface for asking questions about ingested papers
- Office UI shell with four tabs (three greyed, Scribe functional)

## Open questions

- Embeddings: PGVector now or later?
- How to handle PDF parsing for non-arXiv papers
- Cross-paper reasoning views in the UI

## Recent decisions

- Monorepo with pnpm workspaces (over single repo)
- Neon for Postgres (over Supabase)
- Drizzle for ORM (over Prisma)
- arXiv URLs only for tonight's Scribe v1
