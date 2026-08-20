// ---------------------------------------------------------------------------
// Procedural speech blips (Animal Crossing style): a short triangle wave with
// a fast envelope and slight random pitch variation, generated with the Web
// Audio API. No audio assets. MUTED BY DEFAULT; the preference persists; the
// AudioContext is only ever created from a user gesture (the mute toggle),
// which is also what browsers require. Real text-to-speech (the Web Speech
// API) is deliberately not used: it grates on repetition and cannot be tuned.
// ---------------------------------------------------------------------------

const SOUND_STORAGE_KEY = "kazi.bot.sound";
export const SOUND_ENABLED_DEFAULT = false; // muted by default, always

// Blip voice constants.
const BLIP_BASE_HZ = 440; // base pitch; profiles shift around this
const BLIP_PITCH_JITTER = 0.09; // random per-blip variation band
const BLIP_DURATION_S = 0.055; // short; the envelope does the softness
const BLIP_GAIN = 0.045; // low volume; a texture, not a soundtrack
// Per-profile pitch multipliers (playful chirps higher, calm sits lower).
const PROFILE_PITCH: Record<string, number> = {
  playful: 1.18,
  curious: 1.0,
  focused: 0.96,
  calm: 0.88,
};

let audioCtx: AudioContext | null = null;

export function soundPreference(): boolean {
  if (typeof window === "undefined") return SOUND_ENABLED_DEFAULT;
  try {
    const stored = window.localStorage.getItem(SOUND_STORAGE_KEY);
    return stored === null ? SOUND_ENABLED_DEFAULT : stored === "on";
  } catch {
    return SOUND_ENABLED_DEFAULT;
  }
}

export function setSoundPreference(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the preference simply does not persist.
  }
}

// Called from the mute toggle's click handler (a user gesture), which is the
// only place the AudioContext may be created.
export function ensureAudioFromGesture(): void {
  if (audioCtx) {
    void audioCtx.resume();
    return;
  }
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx) audioCtx = new Ctx();
}

// One blip. Silently does nothing when sound is off or no context exists yet
// (i.e. before any user gesture).
export function blip(profile: string, rng: () => number): void {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  const pitchMult = PROFILE_PITCH[profile] ?? 1.0;
  osc.frequency.value = BLIP_BASE_HZ * pitchMult * (1 + (rng() * 2 - 1) * BLIP_PITCH_JITTER);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(BLIP_GAIN, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + BLIP_DURATION_S);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + BLIP_DURATION_S + 0.01);
}
