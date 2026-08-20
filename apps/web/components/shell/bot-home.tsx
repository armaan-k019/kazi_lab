"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOT_DEFAULTS, SchedulerBot } from "@/components/scheduler/scheduler-bot";
import { blip, ensureAudioFromGesture, setSoundPreference, soundPreference } from "@/lib/bot-blip";
import { mulberry32, pickIdleLine, statusSummary, type SpeechContext } from "@/lib/bot-speech";
import { useLab } from "./lab-context";

// ---------------------------------------------------------------------------
// The bot's home: a fixed corner of the primary region where it walks a floor
// line, speaks state-driven lines in a soft bubble, and stays out of the way
// (it fades when the cursor approaches the content beneath it). One bubble at
// a time; new lines crossfade in.
// ---------------------------------------------------------------------------

const BOT_SIZE = 104;
// Typewriter reveal: fast, skippable by clicking the bubble.
const TYPE_MS_PER_CHAR = 25;
const BLIP_EVERY_N_CHARS = 2; // a blip per character is frantic at 25ms; every 2nd reads right
// Bubble hold scales with length, then fades.
const BUBBLE_HOLD_BASE_MS = 2200;
const BUBBLE_HOLD_PER_CHAR_MS = 45;
const BUBBLE_FADE_MS = 350;
// Idle chatter: occasional, never chatty. Event lines bypass this entirely.
const IDLE_SPEECH_INTERVAL_MS = 75_000;
const IDLE_SPEECH_JITTER_MS = 30_000;
// Yield-to-cursor: fade when the pointer comes near the bot's patch.
const YIELD_RADIUS_PX = 150;
const YIELD_OPACITY = 0.25;
// Pacing: the bot walks faster while the lab works (activity 0..1).
const PACE_WADDLE_SPEED_BASE = 0.85;
const PACE_WADDLE_SPEED_GAIN = 0.7;

export function BotHome() {
  const lab = useLab();
  const { botState, speech, say, activity } = lab;
  const [visibleText, setVisibleText] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [fading, setFading] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [yielded, setYielded] = useState(false);
  const homeRef = useRef<HTMLDivElement | null>(null);
  const rngRef = useRef(mulberry32(20260820));
  const lastLineRef = useRef<string | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => setSoundOn(soundPreference()), []);

  const speechCtx: SpeechContext = useMemo(
    () => ({
      web: lab.data,
      scheduler: lab.scheduler,
      groups: lab.groups,
      pipeline: lab.pipeline?.libraries ?? null,
      communityLabel: lab.communityLabel,
    }),
    [lab.data, lab.scheduler, lab.groups, lab.pipeline, lab.communityLabel],
  );
  const speechCtxRef = useRef(speechCtx);
  speechCtxRef.current = speechCtx;

  const clearTimers = () => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  };

  // Present a line: typewriter reveal, hold scaled to length, fade out.
  useEffect(() => {
    if (!speech) return;
    clearTimers();
    setFading(false);
    setVisibleText(speech.text);
    setRevealed(0);
    lastLineRef.current = speech.text;
    const chars = speech.text.length;
    for (let i = 1; i <= chars; i++) {
      timersRef.current.push(
        window.setTimeout(() => {
          setRevealed((r) => Math.max(r, i));
          if (soundOn && i % BLIP_EVERY_N_CHARS === 0) blip(BOT_DEFAULTS.profile, rngRef.current);
        }, i * TYPE_MS_PER_CHAR),
      );
    }
    const hold = chars * TYPE_MS_PER_CHAR + BUBBLE_HOLD_BASE_MS + chars * BUBBLE_HOLD_PER_CHAR_MS;
    timersRef.current.push(window.setTimeout(() => setFading(true), hold));
    timersRef.current.push(
      window.setTimeout(() => {
        setVisibleText(null);
        setFading(false);
      }, hold + BUBBLE_FADE_MS),
    );
    return clearTimers;
    // soundOn changing mid-line should not restart the reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech]);

  // Occasional idle chatter: only true lines, never the same twice in a row,
  // silent while a real bubble is up or the lab is mid-task.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (visibleText === null && (botState === "idle" || botState === "loading")) {
          const line = pickIdleLine(speechCtxRef.current, rngRef.current, lastLineRef.current);
          if (line) say(line);
        }
        schedule();
      }, IDLE_SPEECH_INTERVAL_MS + rngRef.current() * IDLE_SPEECH_JITTER_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // visibleText is read through state at fire time; re-arming per bubble
    // would make chatter cadence depend on chatter itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botState, say]);

  // Yield to content: fade when the cursor approaches the bot's patch.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const el = homeRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      // Inside the bot itself does not yield (it is clickable); the band just
      // outside does, so content under and around it stays reachable.
      setYielded(d > r.width * 0.45 && d < YIELD_RADIUS_PX);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const toggleSound = useCallback(() => {
    // The toggle click is the user gesture that may create the AudioContext.
    ensureAudioFromGesture();
    setSoundOn((v) => {
      setSoundPreference(!v);
      return !v;
    });
  }, []);

  const tuning = useMemo(
    () => ({ waddleSpeed: PACE_WADDLE_SPEED_BASE + PACE_WADDLE_SPEED_GAIN * activity }),
    [activity],
  );

  return (
    <div
      ref={homeRef}
      className="pointer-events-none absolute bottom-1 right-1 z-30 flex flex-col items-end transition-opacity duration-300"
      style={{ opacity: yielded ? YIELD_OPACITY : 1 }}
    >
      {visibleText && (
        <button
          type="button"
          onClick={() => setRevealed(visibleText.length)}
          className="pointer-events-auto relative mb-1 mr-6 max-w-[260px] rounded-2xl border border-border bg-surface/90 px-3 py-2 text-left text-[12px] leading-snug text-text-primary shadow-sm backdrop-blur-sm transition-opacity"
          style={{ opacity: fading ? 0 : 1, transitionDuration: `${BUBBLE_FADE_MS}ms` }}
          title="click to reveal instantly"
        >
          {visibleText.slice(0, revealed)}
          {revealed < visibleText.length && <span className="text-text-muted">…</span>}
          {/* The tail, pointing at the bot. */}
          <span className="absolute -bottom-1.5 right-6 h-3 w-3 rotate-45 border-b border-r border-border bg-surface/90" aria-hidden="true" />
        </button>
      )}
      <div className="pointer-events-auto flex items-end gap-1">
        <button
          type="button"
          onClick={toggleSound}
          className="mb-2 rounded-full border border-border bg-surface/70 px-1.5 py-0.5 text-[10px] text-text-muted backdrop-blur-sm transition-colors hover:border-accent/40 hover:text-accent"
          title={soundOn ? "mute speech blips" : "enable speech blips (off by default)"}
        >
          {soundOn ? "sound on" : "muted"}
        </button>
        <SchedulerBot
          state={botState}
          size={BOT_SIZE}
          tuning={tuning}
          title="scheduler bot (click for a status line)"
          onClick={() => say(statusSummary(speechCtxRef.current))}
        />
      </div>
    </div>
  );
}
