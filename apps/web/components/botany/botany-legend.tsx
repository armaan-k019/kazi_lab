"use client";

// ---------------------------------------------------------------------------
// THE BOTANY KEY: the forest's language, stated plainly so the metaphor is
// unmistakable. Every line matches the generator's real mapping; nothing
// decorative is listed here.
// ---------------------------------------------------------------------------

const KEY: { mark: string; markClass: string; meaning: string }[] = [
  { mark: "bare branches", markClass: "text-warm", meaning: "no synthesis yet" },
  { mark: "full leaves", markClass: "text-green-deep", meaning: "synthesized and audited" },
  { mark: "sparse leaves", markClass: "text-ink-600", meaning: "synthesized, audit pending" },
  { mark: "fruit", markClass: "text-warm", meaning: "metrics extracted (more rows, more fruit)" },
  { mark: "blossoms", markClass: "text-ink-600", meaning: "cross-domain findings" },
  { mark: "glow", markClass: "text-green-deep", meaning: "experiment and document complete" },
  { mark: "vines between trees", markClass: "text-green-deep", meaning: "a real cross-domain link" },
];

export function BotanyLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div>
      <p className="caps-label">how to read a tree</p>
      <ul className={`mt-1.5 ${compact ? "space-y-0.5" : "space-y-1"}`}>
        {KEY.map((k) => (
          <li key={k.mark} className="text-caption text-ink-500">
            <span className={k.markClass}>{k.mark}</span> <span className="text-ink-400">=</span> {k.meaning}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-micro text-ink-400">size follows paper count; branching follows internal citations; hue follows community</p>
    </div>
  );
}
