// ---------------------------------------------------------------------------
// The bot's voice: state-driven, honest lines. Every line is a function of
// LIVE lab state; a line that cannot truthfully be said right now returns
// null and is skipped. The bot never invents a finding, never asserts a
// result, never editorializes about quality. Numbers and names interpolate at
// render time; nothing is hardcoded.
// ---------------------------------------------------------------------------

import type { GroupedFinding } from "@kazi-lab/web-graph/abc-grouping";
import type { PipelineLibrary, SchedulerLatest, WebLatest } from "./types";

export type SpeechContext = {
  web: WebLatest | null;
  scheduler: SchedulerLatest | null;
  groups: GroupedFinding[];
  pipeline: PipelineLibrary[] | null;
  communityLabel: (index: number) => string;
};

export type SpeechCategory = "idle_observation" | "task_lifecycle" | "discovery" | "failure" | "personality";

type LineDef = {
  category: SpeechCategory;
  weight: number;
  line: (ctx: SpeechContext) => string | null; // null = not true right now, skip
};

const relative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// Idle lines: observations that are checkably true, plus a few personality
// lines that assert nothing. Event lines (task start/finish/fail, new
// findings) are built by the functions at the bottom and fire immediately.
export const IDLE_LINES: LineDef[] = [
  {
    category: "idle_observation",
    weight: 1.2,
    line: (c) => {
      const lib = c.pipeline?.find((l) => !l.isAllPapers && l.stages.synthesis.state === "missing" && l.paperCount > 0);
      return lib ? `${lib.name} has no synthesis yet` : null;
    },
  },
  {
    category: "idle_observation",
    weight: 1,
    line: (c) => {
      const n = c.pipeline?.filter((l) => !l.isAllPapers && l.stages.metrics.rows > 0).length ?? 0;
      return n > 0 ? `${n} librar${n === 1 ? "y has" : "ies have"} metrics now` : null;
    },
  },
  {
    category: "idle_observation",
    weight: 1,
    line: (c) => (c.web?.run?.completedAt ? `last web build was ${relative(c.web.run.completedAt)}` : "no web build yet"),
  },
  {
    category: "idle_observation",
    weight: 0.9,
    line: (c) => (c.web ? `${c.web.nodes.length} papers across ${c.web.communities.length} communities` : null),
  },
  {
    category: "idle_observation",
    weight: 1,
    line: (c) => {
      const n = (c.scheduler?.tasks ?? []).filter((t) => t.status === "queued" || t.status === "approved").length;
      return n > 0 ? `${n} task${n === 1 ? "" : "s"} waiting for a decision` : null;
    },
  },
  {
    category: "idle_observation",
    weight: 0.9,
    line: (c) => (c.groups.length > 0 ? `${c.groups.length} grouped finding${c.groups.length === 1 ? "" : "s"} in this build` : null),
  },
  {
    category: "discovery",
    weight: 0.8,
    line: (c) => {
      const g = c.groups[0];
      if (!g) return null;
      return `top bridge: ${c.communityLabel(g.communityPair[0])} and ${c.communityLabel(g.communityPair[1])}, score ${g.bestScore.toFixed(2)}`;
    },
  },
  { category: "personality", weight: 0.5, line: () => "just watching the graph" },
  { category: "personality", weight: 0.5, line: () => "quiet in here" },
  { category: "personality", weight: 0.4, line: () => "counting papers again" },
  { category: "personality", weight: 0.4, line: () => "the clouds are calm today" },
];

// Deterministic PRNG so line schedules are stable per session.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick an idle line: weighted, only lines that are TRUE right now, never the
// same line twice in a row.
export function pickIdleLine(ctx: SpeechContext, rng: () => number, lastLine: string | null): string | null {
  const candidates = IDLE_LINES.map((d) => ({ d, text: d.line(ctx) }))
    .filter((x): x is { d: LineDef; text: string } => x.text !== null)
    .filter((x) => x.text !== lastLine);
  if (candidates.length === 0) return null;
  const total = candidates.reduce((s, x) => s + x.d.weight, 0);
  let r = rng() * total;
  for (const x of candidates) {
    r -= x.d.weight;
    if (r <= 0) return x.text;
  }
  return candidates[candidates.length - 1].text;
}

// On-demand status summary (clicking the bot): plain true numbers.
export function statusSummary(ctx: SpeechContext): string {
  const tasks = ctx.scheduler?.tasks ?? [];
  const executing = tasks.filter((t) => t.status === "executing").length;
  const pending = tasks.filter((t) => t.status === "queued" || t.status === "approved").length;
  const parts = [
    ctx.web ? `${ctx.web.nodes.length} papers` : "web not loaded",
    `${ctx.groups.length} findings`,
    executing > 0 ? `executing ${executing} task${executing === 1 ? "" : "s"}` : pending > 0 ? `${pending} task${pending === 1 ? "" : "s"} pending` : "scheduler idle",
  ];
  return parts.join(", ");
}

// Event lines: fired immediately by the lab context when it observes a real
// transition in scheduler state or a new build's findings.
export function taskStartLine(kind: string, scope: string[]): string {
  const verb: Record<string, string> = {
    extract_metrics: "starting metric extraction",
    re_synthesize: "starting synthesis",
    re_critique: "starting critique",
    extract_cross_domain: "starting cross-domain synthesis",
    propose_crossovers: "starting a proposal run",
  };
  return `${verb[kind] ?? `starting ${kind}`}${scope.length ? ` on ${scope.join(", ")}` : ""}`;
}

export function taskDoneLine(kind: string, scope: string[], elapsedMs: number | null, papersWithMetrics: number | null): string {
  const what: Record<string, string> = {
    extract_metrics: "extraction",
    re_synthesize: "synthesis",
    re_critique: "critique",
    extract_cross_domain: "cross-domain synthesis",
    propose_crossovers: "proposal run",
  };
  const base = `${what[kind] ?? kind} finished${scope.length ? ` on ${scope.join(", ")}` : ""}`;
  const extra: string[] = [];
  // The recorded outcome counts PAPERS that yielded metrics; say exactly that.
  if (papersWithMetrics !== null && papersWithMetrics > 0) extra.push(`metrics from ${papersWithMetrics} papers`);
  if (elapsedMs !== null) extra.push(`took ${Math.max(1, Math.round(elapsedMs / 60_000))}m`);
  return extra.length ? `${base}, ${extra.join(", ")}` : base;
}

export function taskFailedLine(kind: string, scope: string[]): string {
  const what: Record<string, string> = {
    extract_metrics: "extraction",
    re_synthesize: "synthesis",
    re_critique: "critique",
    extract_cross_domain: "cross-domain synthesis",
    propose_crossovers: "the proposal run",
  };
  return `${what[kind] ?? kind} failed${scope.length ? ` on ${scope.join(", ")}` : ""}`;
}

export function newFindingsLine(prev: number, next: number, top: GroupedFinding | null, communityLabel: (i: number) => string): string | null {
  if (next <= prev) return null;
  if (top) return `new grouped finding: ${communityLabel(top.communityPair[0])} and ${communityLabel(top.communityPair[1])}`;
  return `${next - prev} new finding${next - prev === 1 ? "" : "s"} in this build`;
}
