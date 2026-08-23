"use client";

import { AppShell } from "@/components/shell/app-shell";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Discovery: the SAME shell as Research. The field itself renders at page
// level (EnvironmentField) and is FOCUSED on this tab, so the primary region
// here is a transparent window: pointer events fall through it to the field.
// Only the empty state paints anything.
// ---------------------------------------------------------------------------

function PortalWindow() {
  const { data } = useLab();
  if (data?.run) return null; // the focused field shows through
  return (
    <div className="pointer-events-none flex h-full items-center justify-center">
      <div className="max-w-md px-6 text-center">
        <p className="font-display text-display leading-tight text-ink">{data ? "No web yet" : "Loading"}</p>
        <p className="mt-3 text-mid leading-relaxed text-ink-500">
          {data ? "Open Diagnostics and rebuild the web to weave the corpus into the environment." : "Reaching the research web…"}
        </p>
      </div>
    </div>
  );
}

export function DiscoveryShell() {
  return <AppShell tab="discovery" primary={<PortalWindow />} />;
}
