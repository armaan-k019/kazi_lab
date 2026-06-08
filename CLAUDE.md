# CLAUDE.md, kazi-lab conventions

This file governs every Claude Code session for this repository. The most important rules are first.

## TIER 1, hard rules (non-negotiable)

Before any action, verify:
1. Are you about to commit secrets? (Never. Check `.env*` patterns.)
2. Are you about to make commits? (Never without human review.)
3. Are you about to modify files outside the prompt's stated scope? (Never.)
4. Are you about to add libraries not mentioned in the prompt? (Never without explicit justification.)
5. Are you about to use an em dash? (Never. Use commas, periods, or parentheses.)

## TIER 2, prompt output format (required)

Every session ends with a structured summary intended to be pasted into the human's planning chat. Format:

### What was done
Concise factual list of completed steps.

### What worked
Anything that completed cleanly.

### What did not work or required deviation
Errors hit, decisions that differed from the prompt, reasoning behind them. Be honest.

### Decisions worth knowing
Non-obvious choices the human should review.

### What is next
Natural follow-up task if one exists, else "awaiting next prompt."

### Ready for commit
yes/no, and if no, what is unfinished or in a bad state.

## TIER 3, code conventions

- TypeScript strict mode. No `any` unless commented why.
- Tailwind only. No CSS-in-JS, no CSS modules.
- File naming: kebab-case files, PascalCase components, camelCase utilities.
- Server-side only for Claude API calls. Keys never reach the client.
- Small focused functions over large ones.

## TIER 4, architecture principles

- Database-as-substrate: agents integrate through shared database state, not direct calls.
- Provenance everywhere: every output traces to its inputs. Every claim links to its source.
- One source of truth per concept.
- Agents in packages/agents/* expose clean interfaces; agents do not import from each other.

## TIER 5, anti-wrapper test

A real thing must pass at least two:
1. Accumulated state that compounds over time
2. Real computation beyond LLM inference
3. Cross-context value (outputs feed other things)
4. Verification and provenance
5. Non-LLM intelligence alongside the LLM

## TIER 6, workflow

- Plan in chat, execute in Claude Code. Do not conflate.
- For complex multi-file work, enter Plan Mode first (Shift+Tab twice). Read-only research before changes.
- Use /clear between unrelated tasks. Context bloat is the primary failure mode.
- One focused prompt per task.
- After each prompt, update `docs/lessons.md` with anything Claude got wrong.

## TIER 7, git

- Conventional commits: feat:, fix:, refactor:, docs:, chore:
- One logical change per commit. Per-file commits when changes are unrelated.
- Branch naming: type/short-description
- Human reviews every diff before commit.

### Per-prompt rhythm

After every prompt completes, the human follows this rhythm before running the next prompt:

1. Read the structured summary
2. Run `git diff` to spot-check the changes
3. Commit with a clear message tied to the prompt's purpose
4. Push to remote
5. Only then move to the next prompt

Claude Code's responsibilities in this rhythm:
- Leave the working tree in a clean, committable state
- Never bundle unrelated changes in a single prompt
- Never make commits
- Confirm committable state in the "Ready for commit" line of the summary

The reason this matters: committing between prompts gives clean git history, makes mistakes easier to untangle, and creates rollback points. Mistakes pile up across multiple uncommitted prompts and become hard to separate.

## TIER 8, voice

- No em dashes anywhere. Use commas, periods, or parentheses.
- Direct, active prose. No marketing voice. No hype words.
- Honest writing: name uncertainty and tradeoffs.
- No emojis unless functionally necessary.

## TIER 9, stack

Next.js 14+ App Router | TypeScript strict | Tailwind | Postgres via Neon | Drizzle ORM | pnpm workspaces | Vitest | Vercel deployment | Claude API server-side only

## TIER 10, aesthetic

- AI-research-lab look. Not architecture-school. Not generic AI startup.
- Dark mode default. Information density over whitespace.
- Functional color (red warnings, green success, restrained accents).
- Monospace for technical, sans-serif for prose.
- No hero images, no marketing copy, no founder photos.
- Inspirations: Linear, Vercel dashboard, Anthropic console, Observable.

## TIER 11, what NOT to do

- No features beyond prompt scope.
- No new libraries without justification.
- No refactoring unrelated code.
- No UI polish before functionality.
- No tests for code that does not exist.
- No commits before human review.

## See also

- `docs/architecture.md` for system design
- `docs/project-state.md` for current state
- `docs/lessons.md` for accumulated learnings (living document)
- `.claude/skills/` for task-specific instructions
- `.claude/hooks/` for deterministic enforcement
