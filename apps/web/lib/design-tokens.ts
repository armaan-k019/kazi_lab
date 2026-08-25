// ---------------------------------------------------------------------------
// DESIGN TOKENS: the single source of truth for every color, type size,
// radius, glass parameter, ambient-field parameter, and motion duration.
// The CSS layer reads these through the :root variables injected in
// app/layout.tsx; JS consumers (the field scene, the bot) import directly.
//
// DIRECTION (dark spatial environment, World Labs register): the corpus
// graph IS the environment. Deep near-black ground with a faint green cast,
// the living 3D field ambient behind everything, frosted glass floating
// above it, large confident white type, and ONE green used as LIGHT.
//
// NAMING NOTE: the COLOR keys are semantic ROLES kept stable across the
// light-to-dark flip so every mapped utility retints without component
// rewrites: "paper" is THE GROUND role (now near-black), the "ink" ramp is
// THE FOREGROUND ramp (now whites), "greenDeep" is the green-TEXT role (now
// a light tint). The previous light palette is preserved verbatim below as
// COLOR_LIGHT; no theme toggle ships in this pass.
// ---------------------------------------------------------------------------

export const COLOR = {
  // The ground role: deep near-black with a faint green cast, never #000.
  paper: "#0C120E",
  // One lift up: raised dark surfaces and the glass fallback base.
  paperAlt: "#121A14",
  // FOREGROUND ramp (whites on dark). Contrast on ground / worst-case glass:
  ink900: "#EFF4EF", // 17.35 / 10.38: display and primary text
  ink700: "#D8E0D9", // ~14 / ~8.7: body
  ink600: "#C2CCC4", // 11.71 / 7.01: secondary
  ink500: "#98A69C", // 7.61 / 4.55: labels, small caps
  ink400: "#798677", // 5.05 / ~3: faint hints; avoid on bright glass regions
  // Hairlines: white at low alpha, the only rules the UI keeps.
  hairline: "rgba(239, 244, 239, 0.14)",
  hairlineStrong: "rgba(239, 244, 239, 0.26)",
  // GREEN IS LIGHT. core = saturated emission for SMALL elements only
  // (dots, rules, arrows; 8.41 on ground). greenDeep is the green-TEXT role
  // (light tint, 11.71 / 7.00). greenTint is the quiet green fill role.
  green: "#3DD68C",
  greenDeep: "#93E0B6",
  greenTint: "rgba(61, 214, 140, 0.16)",
  greenTintDark: "#93E0B6",
  // Warning semantics, retuned for dark and DIMMER than green so signal
  // outranks warning: warm 8.85 / 5.29, missing 8.05 / 4.82.
  warm: "#D4A86B",
  missing: "#E19480",
  // The field scene's clear color = the ground (one continuous environment).
  portalBg: "#0C120E",
} as const;

// The previous light palette, preserved verbatim as a record (the app ships
// dark-first; no toggle in this pass).
export const COLOR_LIGHT = {
  paper: "#FAF8F3",
  paperAlt: "#F2EFE7",
  ink900: "#1C1D1A",
  ink700: "#34362F",
  ink600: "#4C4F46",
  ink500: "#63665C",
  ink400: "#83867B",
  green: "#2E9968",
  greenDeep: "#1E6B47",
  warm: "#8A6B42",
  missing: "#A44E3E",
} as const;

// Type scale, enforced LARGE this time (previous pass undershot: display was
// 34 and the compact header used 27; the lab name now renders 40px+).
export const TYPE = {
  micro: "10px", // tiny chips and rail monograms only
  caption: "11px", // meta lines
  small: "12px", // dense secondary UI, rail small caps
  ui: "13px", // dense panel UI
  body: "14px", // default reading size
  mid: "15px", // status bar, quiet emphasis (was 15; status bar moved UP to this)
  lead: "18px", // primary tab labels, lead lines (tab minimum per direction)
  title: "24px", // finding headlines, panel titles (was 22)
  headline: "28px", // section headlines (was 27)
  display: "40px", // the compact lab name, display statements (was 34)
  hero: "48px", // the full lab name (was 43)
  trackDisplay: "-0.015em", // gently tight; the friendly sans needs less
  trackBody: "-0.006em",
  trackCaps: "0.14em",
} as const;

export const RADIUS = {
  none: "0px",
  control: "10px", // rounder: friendly, not corporate
  pill: "999px",
  bubble: "16px",
  glass: "16px", // glass panel corners: soft and friendly
} as const;

// GLASS: frosted panels floating over the environment. Elevation is blur
// depth + fill alpha, never shadows. Exactly two levels.
export const GLASS = {
  blur: "14px", // level 1: dock, status bar (lighter, not heavy)
  blurRaised: "22px", // level 2: overlays (fullscreen dock, dev panel)
  fill: "rgba(239, 244, 239, 0.055)", // 3-6 percent white band
  fillRaised: "rgba(239, 244, 239, 0.07)",
  edge: "rgba(239, 244, 239, 0.14)", // 1px lit top edge
  fallback: "rgba(10, 15, 12, 0.88)", // no-backdrop-filter path (contrast verified)
} as const;

// THE AMBIENT FIELD: one canvas, two states. Ambient = dimmed, blurred,
// non-interactive, throttled; focus = the current portal, full clarity.
export const AMBIENT = {
  dim: 0.55, // veil alpha over the field in ambient; raise = calmer ground
  blur: "7px", // veil backdrop blur in ambient; raise = softer field
  activityScale: 0.4, // multiplies activity-driven intensity in ambient
  pulseScale: 0.5, // additional pulse-density halving in ambient (mandated)
  dprCap: 1, // ambient renders at DPR 1; focus restores min(devicePixelRatio, 2)
  frameBudgetMs: 8, // ambient frame budget; exceeding it freezes the field
  freezeDriftS: 60, // the frozen frame's slow CSS drift period
  focusMs: 500, // ambient <-> focus transition (never a cut)
  groundRadial: 0.5, // corner-darkening strength of the page's radial falloff
  // Subtle scrim laid behind dense foreground text that sits directly over
  // the ambient field (the pipeline strip); label suppression is the primary
  // legibility fix, this is the backstop.
  textScrim: 0.38,
  // RESEARCH CALM: on the Research tab the field drops to a whisper so the
  // pipeline strip and library rows read cleanly. researchFieldOff kills it
  // entirely; researchOpacity is the "faint" setting. The dark ground stays
  // either way; this only removes the busy line-web texture behind text.
  researchOpacity: 0.06,
  researchFieldOff: false,
} as const;

// Editorial grid (unchanged intent).
export const GRID = {
  labelIndent: "0px",
  contentIndent: "20px",
  sectionGap: "40px",
  itemGap: "18px",
} as const;

export const MOTION = {
  panelMs: 320,
  discloseMs: 260,
  ease: "cubic-bezier(0.33, 1, 0.4, 1)", // soft-out, gentler than material
} as const;

// Field scene colors (three.js numbers). Community hues are data encoding.
export const PORTAL = {
  bg: 0x0c120e,
  bridge: 0xd8b088,
  labelColor: "#e9e6de",
  communityPalette: [0x7da2d9, 0x8fc4a5, 0xc79bd9, 0xd98f8f, 0x76bcc4, 0xccb37a, 0x9b90d9, 0xd9a3c0, 0x90b878, 0x8a95a8],
  unassigned: 0x8a95a8,
  vignette: "radial-gradient(ellipse at center, transparent 55%, rgba(6, 10, 7, 0.55) 100%)",
} as const;

// The bot: unchanged as a character; body is the living green, belly warm
// white, beak/feet warm. The rim light keeps his silhouette against busy
// field regions.
export const BOT = {
  bodyGreen: "#2E9968",
  belly: "#FAF8F3",
  beak: 0x8a6b42,
  feetTint: 0.78,
  eye: 0x1c1d1a,
  cheek: 0xd9a08f,
  rimColor: 0xeafff2, // faint green-white rim
  rimIntensity: 1.35, // raise if the silhouette melts into bright regions
  halo: "radial-gradient(circle at 60% 65%, rgba(239, 244, 239, 0.10), transparent 70%)",
} as const;

// Categorical ramp for the synthesis timeline (data encoding).
export const THEME_RAMP = [
  "#b07a4f",
  "#6f8f6a",
  "#a36a5b",
  "#5f7f86",
  "#9c8a4e",
  "#86697e",
  "#7e8b5a",
  "#b08968",
  "#6b7f9c",
  "#9a6b66",
  "#5f8f7d",
  "#8a7a6b",
] as const;

// Semantic status colors (dark-tuned; imported, never restated).
export const STATUS = {
  ok: COLOR.green,
  okText: COLOR.greenDeep,
  stale: COLOR.warm,
  missing: COLOR.missing,
  neutral: COLOR.ink500,
  executing: COLOR.greenDeep,
} as const;

// CSS variable bridge: layout.tsx injects into :root; globals.css maps into
// Tailwind via @theme inline. ONE source, no mirrors. The dev tuning panel
// overrides a subset of these live in development builds.
export function cssVariables(): string {
  const vars: Record<string, string> = {
    "--paper": COLOR.paper,
    "--paper-alt": COLOR.paperAlt,
    "--ink-900": COLOR.ink900,
    "--ink-700": COLOR.ink700,
    "--ink-600": COLOR.ink600,
    "--ink-500": COLOR.ink500,
    "--ink-400": COLOR.ink400,
    "--hairline": COLOR.hairline,
    "--hairline-strong": COLOR.hairlineStrong,
    "--green": COLOR.green,
    "--green-deep": COLOR.greenDeep,
    "--green-tint": COLOR.greenTint,
    "--green-tint-dark": COLOR.greenTintDark,
    "--warm": COLOR.warm,
    "--missing": COLOR.missing,
    "--portal-bg": COLOR.portalBg,
    "--glass-blur": GLASS.blur,
    "--glass-blur-raised": GLASS.blurRaised,
    "--glass-fill": GLASS.fill,
    "--glass-fill-raised": GLASS.fillRaised,
    "--glass-edge": GLASS.edge,
    "--glass-fallback": GLASS.fallback,
    "--ambient-dim": String(AMBIENT.dim),
    "--ambient-blur": AMBIENT.blur,
    "--ground-radial": String(AMBIENT.groundRadial),
    "--type-micro": TYPE.micro,
    "--type-caption": TYPE.caption,
    "--type-small": TYPE.small,
    "--type-ui": TYPE.ui,
    "--type-body": TYPE.body,
    "--type-mid": TYPE.mid,
    "--type-lead": TYPE.lead,
    "--type-title": TYPE.title,
    "--type-headline": TYPE.headline,
    "--type-display": TYPE.display,
    "--type-hero": TYPE.hero,
    "--track-display": TYPE.trackDisplay,
    "--track-body": TYPE.trackBody,
    "--track-caps": TYPE.trackCaps,
    "--radius-control": RADIUS.control,
    "--radius-bubble": RADIUS.bubble,
    "--radius-glass": RADIUS.glass,
    "--motion-panel": `${MOTION.panelMs}ms`,
    "--motion-disclose": `${MOTION.discloseMs}ms`,
    "--motion-ease": MOTION.ease,
    "--focus-ms": `${AMBIENT.focusMs}ms`,
  };
  return `:root{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;
}
