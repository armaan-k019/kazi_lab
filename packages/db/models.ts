// Single source of truth for the Anthropic model IDs the agents call. Every
// agent imports a named role from here instead of hardcoding a model string, so
// a model bump happens in exactly ONE place. A wrong string here breaks every
// agent at once, so any change must be verified with a live API call.
//
// This file is intentionally dependency-free (no pg, no side effects) so it is
// safe to import from any server context. Model calls are always server-side.
//
// All roles currently point at Opus 4.8. Extraction was deliberately moved off
// Sonnet onto Opus 4.8 (an accepted cost tradeoff) so the whole lab reasons at
// one tier.
export const MODELS = {
  // Hard cross-paper / cross-domain judgment: Scribe synthesis, per-paper
  // narration, Critic audit + direction-setting abstract, and lab-level
  // cross-domain synthesis.
  judgment: "claude-opus-4-8",
  // Structured reading of a single source: claim extraction, metric extraction,
  // PDF vision transcription, conference-context synthesis, and open-question
  // query distillation.
  extraction: "claude-opus-4-8",
  // The interactive, retrieval-grounded research chat assistant.
  chat: "claude-opus-4-8",
} as const;

export type ModelRole = keyof typeof MODELS;
