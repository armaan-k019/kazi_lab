# Lessons

Living document. Every time Claude Code makes a mistake or a deviation that needed correction, add a one-line lesson here. Future Claude Code sessions read this file and learn from past mistakes.

Format: date, observation, rule going forward.

## Entries

2026-06-01: Claude Code settings.json hook schema requires nested matcher groups, not flat command entries. Rule: when writing hooks, use the format `{ "matcher": "*", "hooks": [{ "type": "command", "command": "..." }] }` per event, not the simplified `{ "command": "..." }` shape.

2026-06-01: Hooks have different failure-mode requirements depending on purpose. Rule: non-critical hooks (notifications, sounds, UX) should fail silently with `|| true` and stderr redirect. Critical hooks (lint, format, security checks, secret scanners) should fail loudly so the user knows enforcement broke.

2026-06-07: Commits should happen after every prompt, not at end of session. Rule: human commits between prompts; Claude Code leaves tree committable. Codified in CLAUDE.md TIER 7. Without this rhythm, mistakes from earlier prompts get bundled with later ones and become harder to isolate.

2026-06-08: Dev servers were killed with a broad `pkill -f "next dev"`, which also stopped the user's unrelated portfolio dev server. Rule: stop dev servers by specific port (`lsof -ti tcp:PORT | xargs kill`) or PID, never broad `pkill`. Also: a kazi-lab `next dev` can linger across prompts and hold the Next project lock (a new `next dev` then refuses to start), so before starting one, check for and stop any lingering server on the target port.
