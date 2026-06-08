---
name: debugging
description: Procedure for debugging unexpected errors or broken behavior. Use when something does not work as expected.
---

# Debugging

When something does not work:

1. Read the actual error message carefully. Do not pattern-match to a remembered fix.
2. Identify whether the error is in: your code, a library, the environment, the database, or the prompt's assumptions.
3. Before changing code, state your hypothesis about what is wrong. Verify the hypothesis before fixing.
4. Make the smallest possible change to test the hypothesis.
5. If your hypothesis is wrong, reset. Do not pile fixes on top of unverified guesses.
6. Document the bug and the fix in docs/lessons.md so the same mistake is not repeated.
