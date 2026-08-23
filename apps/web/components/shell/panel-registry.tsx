"use client";

import type { ComponentType } from "react";
import { CrossDomainView } from "@/components/cross-domain/cross-domain-view";
import { SchedulerView } from "@/components/scheduler/scheduler-view";
import { ScribeView } from "@/components/scribe/scribe-view";
import { CriticView } from "@/components/critic/critic-view";
import { ExperimentalistView } from "@/components/experimentalist/experimentalist-view";
import { WriterView } from "@/components/writer/writer-view";
import { DiscoveriesPanel } from "@/components/discovery/discoveries-panel";
import { DiagnosticsPanel } from "@/components/discovery/diagnostics-panel";
import { LibrariesPanel } from "@/components/research/libraries-panel";
import { useLab } from "./lab-context";

// ---------------------------------------------------------------------------
// THE PANEL REGISTRY: one registry for BOTH tabs; each entry declares which
// tab it belongs to ("discovery", "research", or "both"). The shell renders
// rail and content purely from this array; panels take no props and read
// shared state from useLab(). Adding a future panel (Grasshopper, World Labs,
// VR, Execution Results) is ONE entry plus its component; the shell never
// changes. Worked example in docs/context.md.
// ---------------------------------------------------------------------------

export type ShellTab = "discovery" | "research";

export type PanelBadgeContext = {
  findingCount: number; // grouped findings in the current build
  queuedTasks: number; // scheduler tasks awaiting a decision
  unauditedSyntheses: number; // synthesized libraries missing a current audit
};

export type PanelDef = {
  id: string;
  label: string;
  icon: string; // two-letter monogram (no emoji, per conventions)
  order: number;
  tab: ShellTab | "both";
  component: ComponentType;
  badge?: (ctx: PanelBadgeContext) => number | null;
  enabled?: () => boolean; // disabled entries stay visible, dimmed
};

function SchedulerPanel() {
  const { setBotState } = useLab();
  return <SchedulerView onBotState={setBotState} />;
}

function CrossDomainPanel() {
  return <CrossDomainView />;
}

// Research agent panels: the existing full views, wrapped. They keep their
// own internal library pickers for now; the pipeline strip and the Libraries
// panel share the shell's selected library. Migrating each view's internals
// to the collapsed-card discipline is follow-up work, panel by panel.
function ScribePanel() {
  return <ScribeView />;
}
function CriticPanel() {
  return <CriticView />;
}
function ExperimentalistPanel() {
  return <ExperimentalistView />;
}
function WriterPanel() {
  return <WriterView />;
}

// The disabled placeholder: live proof of the extension path, and Phase 3's
// visible home. It gets the mirrored ink field, one of the interface's
// artistic breathing moments.
function FabricationPanel() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center">
      <div className="max-w-sm px-6 text-center">
        <p className="font-display text-display leading-tight text-ink">Fabrication</p>
        <p className="mt-3 text-mid leading-relaxed text-ink-500">
          Coming in Phase 3: the Rhino/Grasshopper plugin registers here as a panel, carrying geometry
          handoffs from validated findings into parametric models. This entry exists now to prove the
          registry's extension path.
        </p>
      </div>
    </div>
  );
}

export const PANEL_REGISTRY: PanelDef[] = [
  // Discovery.
  { id: "discoveries", label: "Discoveries", icon: "DS", order: 1, tab: "discovery", component: DiscoveriesPanel, badge: (c) => (c.findingCount > 0 ? c.findingCount : null) },
  { id: "diagnostics", label: "Diagnostics", icon: "DX", order: 3, tab: "discovery", component: DiagnosticsPanel },
  { id: "cross-domain", label: "Cross-Domain", icon: "XD", order: 4, tab: "discovery", component: CrossDomainPanel },
  { id: "fabrication", label: "Fabrication", icon: "FB", order: 9, tab: "discovery", component: FabricationPanel, enabled: () => false },
  // Both tabs: lab state is lab state.
  { id: "scheduler", label: "Scheduler", icon: "SC", order: 2, tab: "both", component: SchedulerPanel, badge: (c) => (c.queuedTasks > 0 ? c.queuedTasks : null) },
  // Research.
  { id: "libraries", label: "Libraries", icon: "LB", order: 1, tab: "research", component: LibrariesPanel },
  { id: "scribe", label: "Scribe", icon: "SB", order: 3, tab: "research", component: ScribePanel },
  { id: "critic", label: "Critic", icon: "CR", order: 4, tab: "research", component: CriticPanel, badge: (c) => (c.unauditedSyntheses > 0 ? c.unauditedSyntheses : null) },
  { id: "experimentalist", label: "Experimentalist", icon: "EX", order: 5, tab: "research", component: ExperimentalistPanel },
  { id: "writer", label: "Writer", icon: "WR", order: 6, tab: "research", component: WriterPanel },
];
