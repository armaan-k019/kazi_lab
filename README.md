# kazi-lab

Research lab for applied CS to spatial reasoning and related domains.

Built and operated by Armaan Kazi.

## Status

In active development. Foundation in progress.

## Structure

- `apps/web`, the Office (UI)
- `packages/core`, shared utilities
- `packages/db`, database schema and queries
- `packages/agents/scribe`, Scribe agent
- `docs/`, architecture, project state, decisions

## Stack

See CLAUDE.md.

## Conventions

This repo uses Claude Code with a structured workflow. See:
- `CLAUDE.md` for tiered conventions
- `docs/lessons.md` for accumulated learnings (living document)
- `.claude/skills/` for task-specific instructions
- `.claude/hooks/` for deterministic enforcement

The CLAUDE.md is short by design. Skills handle task-specific instructions to avoid bloating the main conventions file.
