---
name: adding-a-feature
description: Procedure for adding any new feature to kazi-lab. Use whenever the task involves creating new functionality.
---

# Adding a feature

Procedure:

1. Read CLAUDE.md if not already in context.
2. Read docs/architecture.md to understand where the feature fits.
3. Check docs/lessons.md for relevant past learnings.
4. Identify which files will be touched. List them explicitly before changing any.
5. If the feature touches multiple packages, plan the order of changes to avoid breaking intermediate states.
6. Implement the smallest viable version first. Defer polish.
7. Verify each step with a real test (run the dev server, run unit tests, check the output).
8. Update docs/project-state.md with what changed.
9. Produce the prompt output summary per CLAUDE.md TIER 2.
