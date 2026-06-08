"use client";

import { useState } from "react";
import type { Library } from "@/lib/types";

type Props = {
  libraries: Library[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, description: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function LibrarySwitcher({
  libraries,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed, description.trim());
      setName("");
      setDescription("");
      setCreating(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pendingDelete = libraries.find((l) => l.id === confirmDeleteId) ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {libraries.map((lib) => {
          const isActive = lib.id === activeId;
          return (
            <button
              key={lib.id}
              type="button"
              onClick={() => onSelect(lib.id)}
              className={[
                "rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                isActive
                  ? "border-accent/30 bg-accent-dim text-accent"
                  : "border-border text-text-secondary hover:bg-surface-raised hover:text-text-primary",
              ].join(" ")}
            >
              {lib.name}
              <span
                className={isActive ? "text-accent/60" : "text-text-muted"}
              >
                {" · "}
                {lib.paperCount}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            setCreating((v) => !v);
            setConfirmDeleteId(null);
            setError(null);
          }}
          className="rounded-full border border-dashed border-border px-3 py-1.5 text-[13px] text-text-muted transition-colors hover:border-accent/40 hover:text-accent"
        >
          + new library
        </button>

        {/* Delete control for the active, non-general library. */}
        {activeId &&
          (() => {
            const active = libraries.find((l) => l.id === activeId);
            if (!active || active.name === "general") return null;
            if (confirmDeleteId === active.id) return null;
            return (
              <button
                key="delete-active"
                type="button"
                onClick={() => {
                  setConfirmDeleteId(active.id);
                  setCreating(false);
                  setError(null);
                }}
                className="text-[12px] text-text-muted transition-colors hover:text-[#b4493b]"
              >
                delete library
              </button>
            );
          })()}
      </div>

      {/* Inline create form */}
      {creating && (
        <form
          onSubmit={submitCreate}
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3"
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Library name"
            autoFocus
            disabled={busy}
            className="w-44 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            disabled={busy}
            className="w-64 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
          <button
            type="submit"
            disabled={busy || name.trim().length === 0}
            className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setError(null);
            }}
            className="px-2 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
        </form>
      )}

      {/* Inline delete confirmation */}
      {pendingDelete && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3 text-[13px]">
          <span className="text-text-secondary">
            Delete library &ldquo;{pendingDelete.name}&rdquo;? Its papers stay in
            the corpus.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => confirmDelete(pendingDelete.id)}
            className="rounded-md border border-[#b4493b]/30 px-3 py-1 font-medium text-[#b4493b] transition-colors hover:bg-[#b4493b]/8 disabled:opacity-40"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmDeleteId(null)}
            className="px-2 py-1 text-text-muted transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-[13px] text-text-secondary">{error}</p>}
    </div>
  );
}
