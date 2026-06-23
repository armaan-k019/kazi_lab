"use client";

import { useEffect, useState } from "react";
import type { LibraryConference } from "@/lib/types";

const VENUE_TYPES = ["workshop", "full paper", "journal", "poster", "other"];
const STATUSES = ["exploring", "drafting", "proposed"];

type Fields = {
  name: string;
  description: string;
  researchFocus: string;
  hypothesis: string;
  userNotes: string;
  targetVenueType: string;
  status: string;
};
const EMPTY: Fields = {
  name: "",
  description: "",
  researchFocus: "",
  hypothesis: "",
  userNotes: "",
  targetVenueType: "",
  status: "",
};

// A staged (not-yet-saved) conference for create mode.
type StagedConf = {
  name: string;
  sourceKind: "none" | "url" | "text";
  sourceUrl: string;
  rawSourceText: string;
};

// Create or edit a library's research context and conferences. In create mode
// conferences are staged and saved with the library; on save it flips to edit
// mode so the saved conferences gain synthesize controls.
export function LibraryEditor({
  mode,
  libraryId,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  libraryId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [effId, setEffId] = useState<string | null>(
    mode === "edit" ? (libraryId ?? null) : null,
  );
  const isEdit = effId != null;
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [conferences, setConferences] = useState<LibraryConference[]>([]);
  const [staged, setStaged] = useState<StagedConf[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Fields>(k: K, v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  const loadDetail = (id: string) => {
    fetch(`/api/libraries/${id}`)
      .then((r) => r.json())
      .then((b) => {
        const lib = b.library;
        setFields({
          name: lib.name ?? "",
          description: lib.description ?? "",
          researchFocus: lib.researchFocus ?? "",
          hypothesis: lib.hypothesis ?? "",
          userNotes: lib.userNotes ?? "",
          targetVenueType: lib.targetVenueType ?? "",
          status: lib.status ?? "",
        });
        setConferences(lib.conferences ?? []);
      })
      .catch(() => setError("Could not load the library."));
  };

  useEffect(() => {
    if (mode === "edit" && libraryId) loadDetail(libraryId);
  }, [mode, libraryId]);

  const save = async () => {
    if (!fields.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        const res = await fetch(`/api/libraries/${effId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed.");
        loadDetail(effId!);
        onSaved();
      } else {
        const res = await fetch("/api/libraries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...fields,
            conferences: staged.filter((c) => c.name.trim()),
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Create failed.");
        // Flip to edit mode so the saved conferences gain synthesize controls.
        setEffId(body.library.id);
        setStaged([]);
        loadDetail(body.library.id);
        onSaved();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Conference actions (edit mode only; conferences have ids).
  const addConference = async () => {
    if (!effId) return;
    const res = await fetch(`/api/libraries/${effId}/conferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New conference", sourceKind: "none" }),
    });
    if (res.ok) loadDetail(effId);
  };
  const removeConference = async (id: string) => {
    await fetch(`/api/conferences/${id}`, { method: "DELETE" });
    if (effId) loadDetail(effId);
  };

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-medium text-text-primary">
          {isEdit ? "Edit library" : "New library"}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          close
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name (required)">
          <input
            value={fields.name}
            onChange={(e) => set("name", e.target.value)}
            className={inputCls}
            placeholder="library name"
          />
        </Field>
        <Field label="Status (optional)">
          <select
            value={fields.status}
            onChange={(e) => set("status", e.target.value)}
            className={inputCls}
          >
            <option value="">none</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description (optional)">
          <input
            value={fields.description}
            onChange={(e) => set("description", e.target.value)}
            className={inputCls}
            placeholder="short description"
          />
        </Field>
        <Field label="Target venue (optional)">
          <select
            value={fields.targetVenueType}
            onChange={(e) => set("targetVenueType", e.target.value)}
            className={inputCls}
          >
            <option value="">none</option>
            {VENUE_TYPES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-3 space-y-3">
        <Field label="Research focus (optional)">
          <textarea
            value={fields.researchFocus}
            onChange={(e) => set("researchFocus", e.target.value)}
            rows={2}
            className={inputCls}
            placeholder="what this library investigates"
          />
        </Field>
        <Field label="Hypothesis (optional, guides the Critic abstract)">
          <textarea
            value={fields.hypothesis}
            onChange={(e) => set("hypothesis", e.target.value)}
            rows={2}
            className={inputCls}
            placeholder="the claim you want to discover or test"
          />
        </Field>
        <Field label="Private notes (optional, never sent to the AI)">
          <textarea
            value={fields.userNotes}
            onChange={(e) => set("userNotes", e.target.value)}
            rows={2}
            className={inputCls}
            placeholder="your private scratchpad"
          />
        </Field>
      </div>

      {/* Conferences */}
      <div className="mt-5 border-t border-border pt-4">
        <p className="text-[13px] font-medium text-text-secondary">Conferences</p>
        {!isEdit && (
          <p className="mt-1 text-[12px] text-text-muted">
            Add conferences here; after you create the library you can synthesize
            each source into themes and dates.
          </p>
        )}

        {/* Edit mode: saved conferences with synthesize/remove. */}
        {isEdit && (
          <div className="mt-2 space-y-2">
            {conferences.length === 0 && (
              <p className="text-[12px] text-text-muted">No conferences yet.</p>
            )}
            {conferences.map((c) => (
              <ConferenceRow
                key={c.id}
                conf={c}
                onChanged={() => effId && loadDetail(effId)}
                onRemove={() => removeConference(c.id)}
              />
            ))}
            <button
              type="button"
              onClick={addConference}
              className="text-[12px] text-accent transition-opacity hover:opacity-80"
            >
              + add conference
            </button>
          </div>
        )}

        {/* Create mode: staged conferences. */}
        {!isEdit && (
          <div className="mt-2 space-y-2">
            {staged.map((c, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2"
              >
                <input
                  value={c.name}
                  onChange={(e) =>
                    setStaged((s) =>
                      s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                  placeholder="conference name"
                  className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
                />
                <select
                  value={c.sourceKind}
                  onChange={(e) =>
                    setStaged((s) =>
                      s.map((x, j) =>
                        j === i
                          ? { ...x, sourceKind: e.target.value as StagedConf["sourceKind"] }
                          : x,
                      ),
                    )
                  }
                  className="rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
                >
                  <option value="none">no source</option>
                  <option value="url">link</option>
                  <option value="text">pasted text</option>
                </select>
                {c.sourceKind === "url" && (
                  <input
                    value={c.sourceUrl}
                    onChange={(e) =>
                      setStaged((s) =>
                        s.map((x, j) =>
                          j === i ? { ...x, sourceUrl: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="CFP url"
                    className="w-56 rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
                  />
                )}
                {c.sourceKind === "text" && (
                  <textarea
                    value={c.rawSourceText}
                    onChange={(e) =>
                      setStaged((s) =>
                        s.map((x, j) =>
                          j === i ? { ...x, rawSourceText: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="paste CFP / PDF text"
                    rows={2}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
                  className="text-[12px] text-text-muted hover:text-[#b4493b]"
                >
                  remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setStaged((s) => [
                  ...s,
                  { name: "", sourceKind: "none", sourceUrl: "", rawSourceText: "" },
                ])
              }
              className="text-[12px] text-accent transition-opacity hover:opacity-80"
            >
              + add conference
            </button>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-[13px] text-[#b4493b]">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !fields.name.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {isEdit ? "Save changes" : "Create library"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text-primary"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ConferenceRow({
  conf,
  onChanged,
  onRemove,
}: {
  conf: LibraryConference;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [synthing, setSynthing] = useState(false);
  const synthesize = async () => {
    setSynthing(true);
    try {
      await fetch(`/api/conferences/${conf.id}/synthesize`, { method: "POST" });
      onChanged();
    } finally {
      setSynthing(false);
    }
  };
  const hasSource = conf.sourceKind !== "none";
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-text-primary">{conf.name}</span>
        <span className="text-[11px] text-text-muted">
          {conf.sourceKind === "none" ? "name only" : `source: ${conf.sourceKind}`}
        </span>
        {conf.synthStatus === "synthesized" && (
          <span className="text-[11px] text-accent">synthesized</span>
        )}
        {conf.synthStatus === "failed" && (
          <span className="text-[11px] text-[#b4493b]">synth failed</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {hasSource && (
            <button
              type="button"
              onClick={synthesize}
              disabled={synthing}
              className="text-[12px] text-accent transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {synthing ? "synthesizing…" : "synthesize context"}
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="text-[12px] text-text-muted hover:text-[#b4493b]"
          >
            remove
          </button>
        </span>
      </div>
      {conf.notes && (
        <p className="mt-1 text-[11px] text-text-muted">{conf.notes}</p>
      )}
      {conf.synthStatus === "synthesized" && (
        <div className="mt-2 space-y-1 text-[12px] text-text-secondary">
          {conf.scopeSummary && <p>{conf.scopeSummary}</p>}
          {conf.themes && conf.themes.length > 0 && (
            <p className="text-text-muted">themes: {conf.themes.join(", ")}</p>
          )}
          {conf.keyDates && conf.keyDates.length > 0 && (
            <p className="text-text-muted">dates: {conf.keyDates.join(" · ")}</p>
          )}
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}
