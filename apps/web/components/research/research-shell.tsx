"use client";

import { AppShell } from "@/components/shell/app-shell";
import { PipelineStrip } from "./pipeline-strip";

// Research: the SAME shell as Discovery, configured with the pipeline strip
// as its primary region. Panels come from the shared registry (tab:
// "research" or "both").
export function ResearchShell() {
  return <AppShell tab="research" primary={<PipelineStrip />} />;
}
