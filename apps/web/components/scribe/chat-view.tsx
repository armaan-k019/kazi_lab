"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ChatCitation, ChatResponse, ChatUsedChunk } from "@/lib/types";

type Message = {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  usedChunks?: ChatUsedChunk[];
  refused?: boolean;
};

// Grounded chat for one library. Keyed by libraryId in the parent so switching
// libraries remounts it: the conversation resets and stays scoped.
export function ChatView({
  libraryId,
  libraryName,
  onBack,
  onOpenPaper,
}: {
  libraryId: string;
  libraryName: string;
  onBack: () => void;
  onOpenPaper: (paperId: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || sending) return;

    // Short rolling history of prior turns for follow-up context.
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId, question, history }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The assistant could not answer.");
      const r = body as ChatResponse;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: r.answer,
          citations: r.citations,
          usedChunks: r.usedChunks,
          refused: r.refused,
        },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-6 text-[13px] text-text-secondary transition-colors hover:text-accent"
      >
        ← Corpus
      </button>

      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
        Ask · {libraryName}
      </h2>
      <p className="mt-1.5 text-[12px] text-text-muted">
        Answers are grounded only in this library&rsquo;s papers, with citations.
        Asking within <span className="text-accent">{libraryName}</span>.
      </p>

      <div
        ref={listRef}
        className="mt-6 max-h-[52vh] space-y-5 overflow-y-auto pr-1"
      >
        {messages.length === 0 && !sending && (
          <p className="text-sm text-text-muted">
            Ask a question about {libraryName}. If the library does not cover it,
            the assistant will say so rather than guess.
          </p>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-surface-raised px-4 py-2 text-[14px] text-text-primary">
                {m.content}
              </p>
            </div>
          ) : (
            <AssistantMessage key={i} message={m} onOpenPaper={onOpenPaper} />
          ),
        )}

        {sending && (
          <div className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Spinner /> thinking…
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-[13px] text-[#b4493b]">{error}</p>}

      <form onSubmit={ask} className="mt-5 flex gap-2.5">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
          placeholder={`Ask about ${libraryName}…`}
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={sending || input.trim().length === 0}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </motion.div>
  );
}

function AssistantMessage({
  message,
  onOpenPaper,
}: {
  message: Message;
  onOpenPaper: (paperId: string) => void;
}) {
  const [showSources, setShowSources] = useState(false);
  return (
    <div className="max-w-[88%]">
      {message.refused && (
        <span className="mb-1 inline-block rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-text-muted">
          not covered by this library
        </span>
      )}
      <p className="whitespace-pre-wrap text-[15px] leading-[1.65] text-text-primary">
        {message.content}
      </p>

      {message.citations && message.citations.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-text-muted">
            Grounded in
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {message.citations.map((c) => (
              <button
                key={c.paperId}
                type="button"
                onClick={() => onOpenPaper(c.paperId)}
                className="rounded-full bg-accent-dim px-2.5 py-1 text-[12px] text-accent transition-opacity hover:opacity-80"
              >
                {c.paperTitle}
              </button>
            ))}
          </div>
        </div>
      )}

      {message.usedChunks && message.usedChunks.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowSources((v) => !v)}
            className="text-[12px] text-text-muted transition-colors hover:text-accent"
          >
            {showSources ? "hide sources" : `sources (${message.usedChunks.length})`}
          </button>
          {showSources && (
            <ul className="mt-2 space-y-2 border-l border-border pl-3">
              {message.usedChunks.map((u, i) => (
                <li key={i} className="text-[12px] text-text-muted">
                  <span className="text-text-secondary">{u.paperTitle}</span>{" "}
                  <span className="text-text-muted">
                    ({u.similarity.toFixed(2)})
                  </span>
                  <br />
                  {u.content.length > 160
                    ? u.content.slice(0, 159) + "…"
                    : u.content}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent"
      aria-hidden="true"
    />
  );
}
