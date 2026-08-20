"use client";

import { useEffect, useRef } from "react";
import { WebGraph3D } from "@/components/web/web-graph-3d";
import { AppShell } from "@/components/shell/app-shell";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Discovery: the SAME shell as Research, configured with the portal as its
// primary region. All lab state lives in the LabProvider; this file only
// wires the portal into it.
// ---------------------------------------------------------------------------

function PortalPrimary() {
  const lab = useLab();
  const { data, groups, activity, selectedLibraryId } = lab;
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Cross-tab continuity: a library selected in Research softly emphasizes
  // its papers in the portal (a highlight, never a forced view change).
  const emphasisRef = useRef<string | null>(null);
  useEffect(() => {
    emphasisRef.current = selectedLibraryId;
    lab.emphasizeLibrary(selectedLibraryId);
  }, [selectedLibraryId, lab]);

  return (
    <div ref={stageRef} className="h-full bg-[#0b0d10]">
      {data?.run ? (
        <WebGraph3D
          nodes={data.nodes}
          edges={data.edges}
          communities={data.communities}
          abc={data.abc}
          activity={activity}
          fillParent
          onSelect={lab.openPaper}
          onSelectionChange={(refId) => {
            // Portal-to-panel: an ego click filters Discoveries to the paper
            // AND preselects the paper's library for the Research tab
            // (cross-tab continuity, subtle: no view change).
            lab.setSelection(refId ? { kind: "paper", refId } : null);
            if (refId) {
              const node = data.nodes.find((n) => n.refId === refId);
              const libId = node?.libraryIds?.[0];
              if (libId) lab.setSelectedLibraryId(libId);
              lab.openPanel("discoveries");
            }
          }}
          registerApi={(api) => {
            lab.registerPortalApi(api);
            // Re-apply the library emphasis whenever the scene rebuilds.
            if (api && emphasisRef.current) lab.emphasizeLibrary(emphasisRef.current);
          }}
          onThoughtCaptionClick={(index) => {
            lab.openPanel("discoveries");
            const g = groups.find((x) => x.pairings.some((p) => p.sourceIndex === index));
            if (g) lab.setSelection({ kind: "finding", signature: g.signature });
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="max-w-md px-6 text-center text-[14px] leading-relaxed text-text-muted">
            {data ? "No web built yet. Open Diagnostics and rebuild the web to weave the corpus into the portal." : "Loading the research web…"}
          </p>
        </div>
      )}
    </div>
  );
}

export function DiscoveryShell() {
  return <AppShell tab="discovery" primary={<PortalPrimary />} />;
}
