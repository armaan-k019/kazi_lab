"use client";

import { useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Libraries panel: the list with create/edit and a per-library glance line
// (papers, synthesis age, metric rows, critic state). Clicking a row selects
// the library for every Research panel and the pipeline strip.
// ---------------------------------------------------------------------------

export function LibrariesPanel() {
  const { pipeline, reloadPipeline, selectedLibraryId, setSelectedLibraryId } = useLab();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const libs = (pipeline?.libraries ?? []).filter((l) => !l.isAllPapers);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/libraries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "Could not create the library.");
      setName("");
      setDescription("");
      setCreating(false);
      reloadPipeline();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string) => {
    if (!editName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/libraries/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "Could not rename the library.");
      setEditingId(null);
      reloadPipeline();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded-(--radius-control) border border-hairline-strong px-3 py-1.5 text-ui font-medium text-ink-600 transition-colors duration-(--motion-disclose) hover:border-green hover:text-green-deep"
        >
          {creating ? "Cancel" : "New library"}
        </button>
      </div>
      {creating && (
        <div className="space-y-2 border-l-2 border-hairline py-1 pl-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="library name"
            className="w-full rounded-(--radius-control) border border-hairline bg-paper px-2 py-1 text-ui text-ink outline-none focus:border-green"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="description (optional)"
            className="w-full rounded-(--radius-control) border border-hairline bg-paper px-2 py-1 text-ui text-ink outline-none focus:border-green"
          />
          <button type="button" onClick={() => void create()} disabled={busy || !name.trim()} className="rounded-(--radius-control) bg-green-deep px-3 py-1 text-small font-medium text-paper disabled:opacity-50">
            Create
          </button>
        </div>
      )}
      {error && <p className="text-small text-missing">{error}</p>}

      <div className="divide-y divide-hairline">
        {libs.map((l) => {
          const selected = l.id === selectedLibraryId;
          return (
            <div key={l.id} className={`py-3 pl-3 transition-colors duration-(--motion-disclose) first:pt-0 ${selected ? "border-l-2 border-green" : "border-l-2 border-transparent"}`}>
              {editingId === l.id ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 rounded-(--radius-control) border border-hairline bg-paper px-2 py-1 text-ui text-ink outline-none focus:border-green"
                  />
                  <button type="button" onClick={() => void rename(l.id)} disabled={busy} className="text-caption text-green-deep">save</button>
                  <button type="button" onClick={() => setEditingId(null)} className="text-caption text-ink-500">cancel</button>
                </div>
              ) : (
                <button type="button" onClick={() => setSelectedLibraryId(l.id)} className="block w-full text-left">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-lead leading-tight text-ink">{l.name}</p>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(l.id);
                        setEditName(l.name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          setEditingId(l.id);
                          setEditName(l.name);
                        }
                      }}
                      className="ml-auto cursor-pointer text-caption text-ink-500 hover:text-green-deep"
                    >
                      edit
                    </span>
                  </div>
                  <p className="mt-1 text-caption text-ink-500">
                    {l.stages.papers.count} papers · synthesis{" "}
                    {l.stages.synthesis.at ? formatRelativeTime(l.stages.synthesis.at) : l.stages.synthesis.state} ·{" "}
                    {l.stages.metrics.rows} metric rows · critic {l.stages.critic.state === "done" ? "current" : l.stages.critic.state}
                  </p>
                </button>
              )}
            </div>
          );
        })}
        {libs.length === 0 && <p className="text-ui text-ink-500">No libraries yet.</p>}
      </div>
    </div>
  );
}
