"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { SchedulerBotState } from "@/lib/types";
import { BOT } from "@/lib/design-tokens";

// ---------------------------------------------------------------------------
// SchedulerBot: a plush penguin-blob robot, green and white, rounded
// everywhere, zero hard edges. Procedural (no model files). The body top IS
// the head (single blob silhouette); a large white front panel is the
// face-and-belly; flippers, feet, an antenna nub, and a soft ground shadow
// complete the character. Every motion uses squash and stretch with cubic
// easing; states crossfade, never cut.
//
// The /bot-test page is the tuning cockpit: it feeds the `tuning` prop live.
// Final aesthetic calls belong to the human, by eye.
// ---------------------------------------------------------------------------

// TUNING SURFACE: the values the human adjusts by eye on /bot-test.
export type BotProfileName = "calm" | "curious" | "playful" | "focused";

export type BotTuning = {
  bodyGreen: string; // base green hex; flippers/antenna/feet derive from it
  bellyCoverage: number; // 0.4..0.8; fraction of the front the white panel covers
  eyeSize: number; // 0.7..1.4 multiplier; bigger = cuter up to a point
  eyeHeight: number; // -0.15..0.25 vertical offset; LOW eyes read cute, high reads alien
  bounceAmplitude: number; // 0.5..1.5 multiplier on loading/success vertical travel
  breathingSpeed: number; // 0.5..2 multiplier on the idle breath rate
  faceStyle: "beak" | "mouth"; // penguin beak nub vs curved-line mouth
  materialStyle: "soft" | "toon"; // plush-vinyl physical vs 3-step toon
  cheeks: boolean; // faint blush spots
  profile: BotProfileName; // personality preset (coefficient set, no new art)
  waddle: boolean; // idle locomotion on/off
  waddleRollDeg: number; // side-to-side body roll per step; raise = drunker sailor
  waddleSpeed: number; // step rate multiplier; raise = busier walk
  anticFrequency: number; // antic rate multiplier; raise = more of a ham
  wanderRadius: number; // how far from center it wanders (world units)
};

export const BOT_DEFAULTS: BotTuning = {
  bodyGreen: BOT.bodyGreen, // THE living green from the design tokens
  bellyCoverage: 0.62,
  eyeSize: 1.0,
  eyeHeight: 0.0,
  bounceAmplitude: 1.0,
  breathingSpeed: 1.0,
  faceStyle: "beak",
  materialStyle: "soft",
  cheeks: true,
  profile: "curious",
  waddle: true,
  waddleRollDeg: 8,
  waddleSpeed: 1.0,
  anticFrequency: 1.0,
  wanderRadius: 0.7,
};

// ---------------------------------------------------------------------------
// PERSONALITY PROFILES: coefficient sets over the existing animation
// parameters, no new art. anticWeights multiply the base weight of specific
// antics (unlisted antics keep weight 1).
// ---------------------------------------------------------------------------
type BotProfile = {
  breathMult: number; // idle breath rate multiplier
  blinkMult: number; // blink frequency multiplier
  anticIntervalMult: number; // higher = rarer antics
  waddleSpeedMult: number;
  waddleAmplMult: number; // roll/bob amplitude multiplier
  poseRateMult: number; // easing snappiness; higher = quicker transitions
  sparkleMult: number; // success/sneeze sparkle intensity
  wanderMult: number; // wander radius multiplier
  anticWeights: Record<string, number>;
};

export const PROFILES: Record<BotProfileName, BotProfile> = {
  calm: {
    breathMult: 0.75,
    blinkMult: 0.8,
    anticIntervalMult: 2.2,
    waddleSpeedMult: 0.7,
    waddleAmplMult: 0.7,
    poseRateMult: 0.8,
    sparkleMult: 0.6,
    wanderMult: 0.7,
    anticWeights: { stretch_yawn: 1.6, sit_stand: 1.6, spin_dizzy: 0.3, hop: 0.4, flutter_lift: 0.4 },
  },
  curious: {
    breathMult: 1.0,
    blinkMult: 1.1,
    anticIntervalMult: 1.0,
    waddleSpeedMult: 1.0,
    waddleAmplMult: 1.0,
    poseRateMult: 1.0,
    sparkleMult: 1.0,
    wanderMult: 1.1,
    anticWeights: { look_around: 3, follow_cursor: 3, sneeze: 0.7 },
  },
  playful: {
    breathMult: 1.2,
    blinkMult: 1.2,
    anticIntervalMult: 0.55,
    waddleSpeedMult: 1.35,
    waddleAmplMult: 1.3,
    poseRateMult: 1.1,
    sparkleMult: 1.8,
    wanderMult: 1.3,
    anticWeights: { hop: 2.5, flutter_lift: 2, spin_dizzy: 1.6, slip_recover: 1.4 },
  },
  focused: {
    breathMult: 0.9,
    blinkMult: 0.9,
    anticIntervalMult: 3.5,
    waddleSpeedMult: 0.9,
    waddleAmplMult: 0.8,
    poseRateMult: 1.5,
    sparkleMult: 0.8,
    wanderMult: 0.4,
    anticWeights: { look_around: 0.5, follow_cursor: 0.3, spin_dizzy: 0.1, hop: 0.3, slip_recover: 0.2, stretch_yawn: 0.5 },
  },
};

// When on, the profile shifts with lab state: executing or thinking states
// snap the coefficients to "focused" (the picker still owns idle).
const PROFILE_FOLLOWS_LAB_STATE = true;

// The imperative surface /bot-test uses to fire antics on demand.
export type BotApi = { fireAntic(name: string): void; antics: string[] };

// ---------------------------------------------------------------------------
// Fixed constants. Comments say what raising the value does visually.
// ---------------------------------------------------------------------------
const BOT_SIZE_PX = 120;
const PIXEL_RATIO_CAP = 2;

// Silhouette. RX/RY set the egg proportions (RY/RX ~1.25 = plush penguin).
const BODY_RX = 0.78; // body half-width; raise = rounder, squatter
const BODY_RY = 0.98; // body half-height; raise = taller egg
const BODY_RZ_SCALE = 0.95; // front-back flatten; lower = flatter plush
const BODY_BOTTOM_BULGE = 0.16; // extra width in the bottom third; raise = more weighted
const BODY_SIT = 0.86; // where the bottom flattens (fraction of RY); lower = flatter seat
const LATHE_SEGMENTS = 48; // radial smoothness; raise if any facet shows

// Palette.
const BELLY_WHITE = BOT.belly; // paper white from the design tokens
const EYE_COLOR = BOT.eye; // the palette ink
const EYE_HIGHLIGHT = 0xffffff;
const BEAK_COLOR = BOT.beak; // the palette warm neutral
const MOUTH_COLOR = 0x2a3034; // curved-line mouth (FACE_STYLE "mouth")
const CHEEK_COLOR = BOT.cheek; // faint blush, warmed to sit in the palette
const CHEEK_OPACITY = 0.28; // sprite peak alpha; the soft texture makes it read ~0.05
const FEET_TINT = BOT.feetTint; // feet darken the body green by this factor
const ANTENNA_TINT = 0.8; // antenna darkens the body green by this factor
const SHADOW_OPACITY = 0.15; // ground contact shadow; raise = heavier grounding

// Face layout (relative to the body; eyeHeight tuning shifts on top of this).
const EYE_BASE_Y = 0.06; // resting eye height; low-set reads cute
const EYE_SPACING = 0.30; // half distance between eye centers; wide-set reads friendly
const EYE_Z = 0.63; // how far forward the face sits
const EYE_W = 0.30; // eye width, ~19 percent of body width at defaults
const EYE_H = 0.36; // eye height; taller than wide reads plush
const EYE_RADIUS = 0.13; // rounded-rect corner radius; raise = closer to oval
const HIGHLIGHT_R = 0.045; // specular dot radius
const BEAK_Y_OFFSET = -0.24; // beak sits this far below the eyes
const CHEEK_Y_OFFSET = -0.16;
const CHEEK_X = 0.47;
const CHEEK_SCALE = 0.24;

// Material.
const SOFT_ROUGHNESS = 0.55;
const SOFT_CLEARCOAT = 0.4;
const SOFT_CLEARCOAT_ROUGHNESS = 0.6;

// Animation timing (seconds unless noted). Everything eased, nothing linear.
const BREATH_PERIOD_S = 3.2; // idle breath cycle
const BREATH_AMPLITUDE = 0.03; // scale-Y swing 1.00..1.03
const BLINK_MIN_S = 3; // randomized blink interval band
const BLINK_MAX_S = 6;
const BLINK_CLOSE_S = 0.08; // one lid close or open takes this long
const DOUBLE_BLINK_CHANCE = 0.4; // fraction of blinks that come as a quick pair
const WEIGHT_SHIFT_S = 8; // idle lean interval (6..10s band)
const WEIGHT_SHIFT_RAD = 0.035; // ~2 degrees
const POSE_RATE = 8; // 1/s crossfade toward pose targets (~250ms transitions)
const THINK_TILT_RAD = 0.105; // ~6 degrees lean
const LOAD_BOUNCE_PERIOD_S = 0.9; // loading bounce cycle
const LOAD_BOUNCE_HEIGHT = 0.14; // hop height (x bounceAmplitude)
const LOAD_SQUASH = 0.1; // landing compression during loading
const SUCCESS_TOTAL_S = 1.2; // whole success beat, then back to idle motion
const SUCCESS_JUMP = 0.34; // jump height (x bounceAmplitude)
const ERROR_DEFLATE = 0.92; // scale-Y hold during error (8 percent down)
const ERROR_BOB_S = 2.2; // slow sad bob period
const HOVER_SCALE = 1.08;
const GAZE_RANGE = 0.05; // pupil-less design: whole eyes shift subtly toward cursor

// Waddle locomotion (idle only). Real weight-shift: roll into the planted
// side, alternating foot lifts, a small bob, squash on each plant.
const WADDLE_STEP_HZ = 2.1; // steps per second at waddleSpeed 1
const WADDLE_BOB = 0.035; // vertical bob per step; raise = bouncier walk
const WADDLE_FOOT_LIFT = 0.05; // foot nub lift height
const WADDLE_LEAN = 0.05; // forward lean into movement (radians)
const WADDLE_MOVE_SPEED = 0.28; // world units per second of travel
const WADDLE_FLIPPER_SWING = 0.22; // counter-swing amplitude
const WADDLE_TURN_RATE = 3.0; // 1/s easing of the facing direction
const WADDLE_MAX_YAW = 0.85; // radians; never fully turns its back
const WANDER_INTERVAL_S_MIN = 2.5; // idle seconds between wanders; lower = inhabits the space
const WANDER_INTERVAL_S_MAX = 7;
const WANDER_CHAIN_PROB = 0.5; // chance a wander continues into another leg (direction change)
const WANDER_CENTER_PULL = 0.45; // fraction of each target pulled toward center
const WANDER_MARGIN = 0.12; // container-edge margin in world units
// The bot walks a FLOOR LINE: wander depth is a small fraction of the lateral
// range, so it paces left and right rather than drifting through space.
const WANDER_Z_FACTOR = 0.12;

// Antics (idle only; real states always win and cancel gracefully).
const ANTIC_INTERVAL_S_MIN = 5; // band between antics at anticFrequency 1
const ANTIC_INTERVAL_S_MAX = 11;
const ANTIC_FADE_RATE = 8; // 1/s fade-out when a real state interrupts (~250ms)

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number) => t * t * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// Eased bump inside the window [a, b]: 0 outside, sine arc inside.
const win = (p: number, a: number, b: number) => (p < a || p > b ? 0 : Math.sin(Math.PI * ((p - a) / (b - a))));
// Smooth plateau: rises over [a1, a2], holds, falls over [b1, b2].
const plateau = (p: number, a1: number, a2: number, b1: number, b2: number) => smoothstep(a1, a2, p) * (1 - smoothstep(b1, b2, p));

// ---------------------------------------------------------------------------
// ANTICS: named, self-contained timelines with anticipation, action, and
// settle phases. Every pose function starts AND ends at neutral (p=0 and p=1
// produce zero offsets), so a completed antic hands back to idle seamlessly.
// p is 0..1 through the antic; r is a per-run random in [0, 1).
// ---------------------------------------------------------------------------
type AnticPose = {
  x?: number;
  y?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  squashDelta?: number; // added to the squash target (volume-preserved)
  flipL?: number; // added to the flipper targets
  flipR?: number;
  eyesClosed?: number; // 0..1
  gazeFollow?: number; // 0..1 extra cursor-follow weight
  sparkle?: boolean; // request a small sparkle burst
};
type AnticDef = { name: string; duration: number; weight: number; pose: (p: number, r: number) => AnticPose };

const ANTICS: AnticDef[] = [
  {
    name: "stretch_yawn",
    duration: 2.4,
    weight: 1,
    pose: (p) => ({
      squashDelta: -0.06 * win(p, 0, 0.22) + 0.14 * win(p, 0.22, 0.75),
      flipL: 1.5 * win(p, 0.25, 0.75),
      flipR: -1.5 * win(p, 0.25, 0.75),
      eyesClosed: win(p, 0.3, 0.72),
      rotX: -0.08 * win(p, 0.25, 0.75), // chin up into the yawn
    }),
  },
  {
    name: "spin_dizzy",
    duration: 2.8,
    weight: 1,
    pose: (p) => ({
      rotY: -0.45 * win(p, 0, 0.2) + (p >= 0.2 && p < 0.68 ? Math.PI * 2 * easeInOutCubic((p - 0.2) / 0.48) : p >= 0.68 ? Math.PI * 2 : 0),
      rotZ: p > 0.68 ? 0.16 * Math.sin((p - 0.68) * 34) * (1 - (p - 0.68) / 0.32) : 0,
      eyesClosed: 0.5 * win(p, 0.7, 0.95), // woozy after the spin
    }),
  },
  {
    name: "hop",
    duration: 1.1,
    weight: 1,
    pose: (p) => ({
      squashDelta: -0.13 * win(p, 0, 0.26) + 0.1 * win(p, 0.4, 0.6) - 0.11 * win(p, 0.72, 0.88),
      y: 0.16 * win(p, 0.26, 0.74),
    }),
  },
  {
    name: "look_around",
    duration: 3.0,
    weight: 1,
    pose: (p, r) => ({
      rotY: (r > 0.5 ? 1 : -1) * (0.5 * win(p, 0.05, 0.45) - 0.5 * win(p, 0.52, 0.92)),
      rotZ: 0.04 * win(p, 0.05, 0.45) - 0.04 * win(p, 0.52, 0.92),
    }),
  },
  {
    name: "slip_recover",
    duration: 1.9,
    weight: 0.8,
    pose: (p, r) => ({
      rotZ: (r > 0.5 ? 1 : -1) * (-0.34 * win(p, 0.05, 0.32) + 0.12 * win(p, 0.45, 0.7)),
      y: -0.05 * win(p, 0.1, 0.32),
      flipL: 0.9 * Math.sin(p * 40) * win(p, 0.08, 0.45),
      flipR: -0.9 * Math.sin(p * 40 + 1.3) * win(p, 0.08, 0.45),
    }),
  },
  {
    name: "follow_cursor",
    duration: 2.6,
    weight: 1,
    pose: (p) => ({ gazeFollow: win(p, 0.08, 0.92) }),
  },
  {
    name: "sneeze",
    duration: 1.7,
    weight: 0.7,
    pose: (p) => ({
      squashDelta: 0.08 * win(p, 0, 0.42) - 0.14 * win(p, 0.42, 0.62),
      rotX: -0.1 * win(p, 0, 0.42) + 0.32 * win(p, 0.42, 0.6),
      eyesClosed: smoothstep(0.15, 0.42, p) * (1 - smoothstep(0.6, 0.8, p)),
      sparkle: p >= 0.45 && p <= 0.5,
    }),
  },
  {
    name: "sit_stand",
    duration: 3.2,
    weight: 0.9,
    pose: (p) => ({
      squashDelta: -0.16 * plateau(p, 0.06, 0.22, 0.72, 0.92),
      flipL: -0.25 * plateau(p, 0.06, 0.22, 0.72, 0.92),
      flipR: 0.25 * plateau(p, 0.06, 0.22, 0.72, 0.92),
    }),
  },
  {
    name: "flutter_lift",
    duration: 1.9,
    weight: 0.9,
    pose: (p) => ({
      flipL: 1.1 * Math.sin(p * 52) * win(p, 0.08, 0.62),
      flipR: -1.1 * Math.sin(p * 52) * win(p, 0.08, 0.62),
      y: 0.1 * win(p, 0.22, 0.68),
      squashDelta: -0.08 * win(p, 0.68, 0.82),
    }),
  },
  {
    name: "peck_nod",
    duration: 2.2,
    weight: 1,
    pose: (p) => ({
      // Turns toward the panel edge (the dock sits to its right) and pecks
      // three times: anticipation lean, nods, settle back.
      rotY: 0.5 * plateau(p, 0.05, 0.2, 0.78, 0.95),
      rotX: (0.22 * Math.max(0, Math.sin((p - 0.22) * Math.PI * 6)) + 0.04) * plateau(p, 0.18, 0.26, 0.72, 0.85),
      squashDelta: -0.03 * plateau(p, 0.18, 0.26, 0.72, 0.85),
    }),
  },
  {
    name: "blink_stretch",
    duration: 2.8,
    weight: 1,
    pose: (p) => ({
      // A slow contented blink that melts into a gentle upward stretch.
      eyesClosed: plateau(p, 0.05, 0.3, 0.55, 0.8),
      squashDelta: 0.1 * win(p, 0.3, 0.85),
      rotX: -0.06 * win(p, 0.3, 0.85),
      flipL: 0.5 * win(p, 0.35, 0.85),
      flipR: -0.5 * win(p, 0.35, 0.85),
    }),
  },
  {
    name: "notice_wave",
    duration: 2.4,
    weight: 1.1,
    pose: (p) => ({
      // Notices the user: turns toward the cursor (gazeFollow drives the
      // turn), then one small friendly wave with the right flipper.
      gazeFollow: plateau(p, 0.05, 0.2, 0.85, 0.98),
      flipR: -(1.9 + 0.5 * Math.sin(p * 26)) * plateau(p, 0.28, 0.4, 0.7, 0.88),
      rotZ: -0.04 * plateau(p, 0.28, 0.4, 0.7, 0.88),
    }),
  },
];

// Deterministic PRNG so blink/weight-shift schedules are stable per mount.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft radial texture (shadow, cheeks, sparkles, thought dots, error cloud).
function makeSoftTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Egg-blob body: lathe of a hand-tuned profile. Wider bottom third, softly
// flattened seat, smooth everywhere.
function makeBodyGeometry(): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const N = 44;
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0 top pole, 1 bottom pole
    const ang = t * Math.PI;
    let r = Math.sin(ang);
    let y = Math.cos(ang);
    r *= 1 + BODY_BOTTOM_BULGE * Math.pow(Math.max(0, t - 0.42) / 0.58, 1.6);
    if (y < -BODY_SIT) y = -BODY_SIT + (y + BODY_SIT) * 0.25; // soft seat
    pts.push(new THREE.Vector2(Math.max(r * BODY_RX, 1e-4), y * BODY_RY));
  }
  const geo = new THREE.LatheGeometry(pts, LATHE_SEGMENTS);
  geo.computeVertexNormals();
  return geo;
}

// Paint the belly: white front panel over green, blended by front-facing
// amount and an elliptical mask, so the boundary is soft (no decal seam).
function paintBody(geo: THREE.BufferGeometry, greenHex: string, bellyCoverage: number): void {
  const posA = geo.getAttribute("position") as THREE.BufferAttribute;
  let colA = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!colA) {
    colA = new THREE.BufferAttribute(new Float32Array(posA.count * 3), 3);
    geo.setAttribute("color", colA);
  }
  const green = new THREE.Color(greenHex);
  const white = new THREE.Color(BELLY_WHITE);
  const c = new THREE.Color();
  const bellyW = BODY_RX * (0.45 + 0.55 * bellyCoverage);
  const bellyH = BODY_RY * (0.5 + 0.6 * bellyCoverage);
  const bellyCenterY = -0.08 * BODY_RY; // panel reaches up over the face, down over the belly
  for (let i = 0; i < posA.count; i++) {
    const x = posA.getX(i);
    const y = posA.getY(i);
    const z = posA.getZ(i);
    const front = smoothstep(0.02, 0.42, z / BODY_RX);
    const d = Math.hypot(x / bellyW, (y - bellyCenterY) / bellyH);
    const mask = 1 - smoothstep(0.82, 1.06, d);
    c.copy(green).lerp(white, front * mask);
    colA.setXYZ(i, c.r, c.g, c.b);
  }
  colA.needsUpdate = true;
}

// Rounded-rect eye shape (large, plush).
function makeEyeGeometry(): THREE.ShapeGeometry {
  const w = EYE_W / 2;
  const h = EYE_H / 2;
  const r = EYE_RADIUS;
  const s = new THREE.Shape();
  s.moveTo(-w + r, -h);
  s.lineTo(w - r, -h);
  s.quadraticCurveTo(w, -h, w, -h + r);
  s.lineTo(w, h - r);
  s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h);
  s.quadraticCurveTo(-w, h, -w, h - r);
  s.lineTo(-w, -h + r);
  s.quadraticCurveTo(-w, -h, -w + r, -h);
  return new THREE.ShapeGeometry(s, 10);
}

// Closed-happy eye arc (an upside-down U), used for loading and success.
function makeHappyArcGeometry(): THREE.TubeGeometry {
  const w = EYE_W * 0.52;
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-w, -0.03, 0),
    new THREE.Vector3(0, 0.13, 0),
    new THREE.Vector3(w, -0.03, 0),
  );
  return new THREE.TubeGeometry(curve, 12, 0.032, 8, false);
}

// Curved-line mouth (FACE_STYLE "mouth").
function makeMouthGeometry(): THREE.TubeGeometry {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.11, 0.02, 0),
    new THREE.Vector3(0, -0.06, 0),
    new THREE.Vector3(0.11, 0.02, 0),
  );
  return new THREE.TubeGeometry(curve, 12, 0.024, 8, false);
}

// 3-step gradient map for the toon material.
function makeToonGradient(): THREE.DataTexture {
  const data = new Uint8Array([90, 170, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

type BodyMaterialPair = { body: THREE.Material; solid: (hex: number | string) => THREE.Material };

function makeMaterials(style: BotTuning["materialStyle"], gradient: THREE.DataTexture): BodyMaterialPair {
  if (style === "toon") {
    return {
      body: new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient }),
      solid: (hex) => new THREE.MeshToonMaterial({ color: new THREE.Color(hex as string), gradientMap: gradient }),
    };
  }
  return {
    body: new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: SOFT_ROUGHNESS,
      metalness: 0,
      clearcoat: SOFT_CLEARCOAT,
      clearcoatRoughness: SOFT_CLEARCOAT_ROUGHNESS,
    }),
    solid: (hex) =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(hex as string),
        roughness: SOFT_ROUGHNESS,
        metalness: 0,
        clearcoat: SOFT_CLEARCOAT,
        clearcoatRoughness: SOFT_CLEARCOAT_ROUGHNESS,
      }),
  };
}

export function SchedulerBot({
  state,
  onClick,
  size = BOT_SIZE_PX,
  title,
  tuning,
  registerApi,
}: {
  state: SchedulerBotState;
  onClick?: () => void;
  size?: number;
  title?: string;
  tuning?: Partial<BotTuning>;
  // /bot-test uses this to fire antics on demand by name.
  registerApi?: (api: BotApi | null) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SchedulerBotState>(state);
  const stateEnteredAtRef = useRef<number>(0);
  const tuningRef = useRef<BotTuning>({ ...BOT_DEFAULTS, ...tuning });
  const applyTuningRef = useRef<((t: BotTuning) => void) | null>(null);

  useEffect(() => {
    if (stateRef.current !== state) {
      stateRef.current = state;
      stateEnteredAtRef.current = performance.now();
    }
  }, [state]);

  // Live tuning: merged over defaults, applied in place (no scene rebuild).
  useEffect(() => {
    tuningRef.current = { ...BOT_DEFAULTS, ...tuning };
    applyTuningRef.current?.(tuningRef.current);
  }, [tuning]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 0.28, 4.6);
    camera.lookAt(0, 0.05, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.setSize(size, size);
    mount.appendChild(renderer.domElement);

    // The bot's own light rig: warm key upper-left, cool fill right, rim from
    // behind-top so the silhouette pops on any background.
    scene.add(new THREE.AmbientLight(0xffffff, 0.34));
    const key = new THREE.DirectionalLight(0xffe9d2, 1.25);
    key.position.set(-2.2, 3, 2.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd6e6ff, 0.55);
    fill.position.set(2.5, 0.8, 1.5);
    scene.add(fill);
    // Rim light from the tokens: keeps the silhouette against busy field
    // regions on the dark environment.
    const rim = new THREE.DirectionalLight(BOT.rimColor, BOT.rimIntensity);
    rim.position.set(0.4, 2.6, -3);
    scene.add(rim);

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    const softTex = track(makeSoftTexture());
    const toonGradient = track(makeToonGradient());

    // Scene graph: root sits at the GROUND so squash pivots at the feet, not
    // the belly. content holds the body one lift up.
    const GROUND_Y = -1.02;
    const BODY_LIFT = 0.9;
    const root = new THREE.Group();
    root.position.set(0, GROUND_Y, 0);
    scene.add(root);
    const content = new THREE.Group();
    content.position.y = BODY_LIFT;
    root.add(content);
    const lean = new THREE.Group(); // rotZ/rotX pose leans
    content.add(lean);

    // Body.
    const bodyGeo = track(makeBodyGeometry());
    let mats = makeMaterials(tuningRef.current.materialStyle, toonGradient);
    let bodyMat = track(mats.body);
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.scale.z = BODY_RZ_SCALE;
    lean.add(bodyMesh);
    paintBody(bodyGeo, tuningRef.current.bodyGreen, tuningRef.current.bellyCoverage);

    // Flippers: squashed capsules pivoted at the shoulder.
    const flipperGeo = track(new THREE.CapsuleGeometry(0.1, 0.36, 6, 14));
    let flipperMat = track(mats.solid(tuningRef.current.bodyGreen));
    const makeFlipper = (side: -1 | 1) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * BODY_RX * 0.94, 0.12, 0.02);
      const mesh = new THREE.Mesh(flipperGeo, flipperMat);
      mesh.scale.set(1, 1, 0.45); // flattened, flipper-like
      mesh.position.y = -0.22; // hang from the shoulder pivot
      pivot.add(mesh);
      lean.add(pivot);
      return pivot;
    };
    const FLIP_REST = 0.55; // resting angle, slightly out and down
    const flipperL = makeFlipper(-1);
    const flipperR = makeFlipper(1);
    flipperL.rotation.z = FLIP_REST;
    flipperR.rotation.z = -FLIP_REST;

    // Feet: tiny rounded nubs peeking from under the front.
    const feetGeo = track(new THREE.SphereGeometry(0.115, 20, 14));
    const feetColor = new THREE.Color(tuningRef.current.bodyGreen).multiplyScalar(FEET_TINT);
    let feetMat = track(mats.solid(`#${feetColor.getHexString()}`));
    const feet: THREE.Mesh[] = [];
    for (const side of [-1, 1] as const) {
      const foot = new THREE.Mesh(feetGeo, feetMat);
      foot.scale.set(1.15, 0.5, 1.35);
      foot.position.set(side * 0.27, -BODY_RY * BODY_SIT - 0.02, 0.3);
      lean.add(foot);
      feet.push(foot);
    }

    // Antenna nub: the one small detail that sells "robot".
    const antennaColor = new THREE.Color(tuningRef.current.bodyGreen).multiplyScalar(ANTENNA_TINT);
    let antennaMat = track(mats.solid(`#${antennaColor.getHexString()}`));
    const antennaStemGeo = track(new THREE.CylinderGeometry(0.02, 0.025, 0.12, 10));
    const antennaTipGeo = track(new THREE.SphereGeometry(0.05, 14, 10));
    const antenna = new THREE.Group();
    const stem = new THREE.Mesh(antennaStemGeo, antennaMat);
    const tip = new THREE.Mesh(antennaTipGeo, antennaMat);
    tip.position.y = 0.09;
    antenna.add(stem);
    antenna.add(tip);
    antenna.position.set(0.12, BODY_RY * 0.99, 0);
    antenna.rotation.z = -0.12;
    lean.add(antenna);

    // Face group: eyes (rounded rects + highlight), happy arcs, beak/mouth,
    // cheeks. Everything on the white panel, low-set.
    const face = new THREE.Group();
    lean.add(face);
    const eyeGeo = track(makeEyeGeometry());
    const eyeMat = track(new THREE.MeshBasicMaterial({ color: EYE_COLOR }));
    const highlightGeo = track(new THREE.CircleGeometry(HIGHLIGHT_R, 16));
    const highlightMat = track(new THREE.MeshBasicMaterial({ color: EYE_HIGHLIGHT }));
    const arcGeo = track(makeHappyArcGeometry());
    const arcMat = track(new THREE.MeshBasicMaterial({ color: EYE_COLOR }));
    type Eye = { group: THREE.Group; open: THREE.Mesh; arc: THREE.Mesh; side: -1 | 1 };
    const makeEye = (side: -1 | 1): Eye => {
      const group = new THREE.Group();
      group.position.set(side * EYE_SPACING, EYE_BASE_Y, EYE_Z);
      const open = new THREE.Mesh(eyeGeo, eyeMat);
      const hl = new THREE.Mesh(highlightGeo, highlightMat);
      hl.position.set(-side * EYE_W * 0.2, EYE_H * 0.24, 0.005); // upper inner corner
      open.add(hl);
      const arc = new THREE.Mesh(arcGeo, arcMat);
      arc.visible = false;
      group.add(open);
      group.add(arc);
      face.add(group);
      return { group, open, arc, side };
    };
    const eyeL = makeEye(-1);
    const eyeR = makeEye(1);

    // Beak (rounded nub) and mouth (curved line): FACE_STYLE picks one.
    const beakGeo = track(new THREE.ConeGeometry(0.085, 0.16, 18));
    const beakMat = track(new THREE.MeshStandardMaterial({ color: BEAK_COLOR, roughness: 0.5 }));
    const beak = new THREE.Mesh(beakGeo, beakMat);
    beak.rotation.x = Math.PI / 2 - 0.18; // tip forward, a touch downward
    beak.position.set(0, EYE_BASE_Y + BEAK_Y_OFFSET, EYE_Z + 0.08);
    face.add(beak);
    const mouthGeo = track(makeMouthGeometry());
    const mouthMat = track(new THREE.MeshBasicMaterial({ color: MOUTH_COLOR }));
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, EYE_BASE_Y + BEAK_Y_OFFSET, EYE_Z + 0.02);
    mouth.visible = false;
    face.add(mouth);

    // Cheeks: very faint blush sprites.
    const cheekMatL = track(new THREE.SpriteMaterial({ map: softTex, color: CHEEK_COLOR, transparent: true, opacity: CHEEK_OPACITY, depthWrite: false }));
    const cheekMatR = track(new THREE.SpriteMaterial({ map: softTex, color: CHEEK_COLOR, transparent: true, opacity: CHEEK_OPACITY, depthWrite: false }));
    const cheeks: THREE.Sprite[] = [];
    for (const [side, m] of [[-1, cheekMatL], [1, cheekMatR]] as const) {
      const cheek = new THREE.Sprite(m);
      cheek.position.set(side * CHEEK_X, EYE_BASE_Y + CHEEK_Y_OFFSET, EYE_Z + 0.02);
      cheek.scale.setScalar(CHEEK_SCALE);
      face.add(cheek);
      cheeks.push(cheek);
    }

    // Ground shadow: soft ellipse that widens on squash, fades on jumps.
    const shadowGeo = track(new THREE.PlaneGeometry(1, 1));
    const shadowMat = track(new THREE.MeshBasicMaterial({ map: softTex, color: 0x000000, transparent: true, opacity: SHADOW_OPACITY, depthWrite: false }));
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, GROUND_Y + 0.005, 0.1);
    shadow.scale.set(1.5, 1.0, 1);
    scene.add(shadow);

    // Thinking dots, error cloud, success sparkles: small sprite effects.
    const dotMats: THREE.SpriteMaterial[] = [];
    const dots: THREE.Sprite[] = [];
    for (let i = 0; i < 3; i++) {
      const m = track(new THREE.SpriteMaterial({ map: softTex, color: 0xdfe7ee, transparent: true, opacity: 0, depthWrite: false }));
      dotMats.push(m);
      const d = new THREE.Sprite(m);
      d.position.set(0.72 + i * 0.17, BODY_LIFT + 0.72 + i * 0.12, 0.2);
      d.scale.setScalar(0.09 + i * 0.02);
      root.add(d);
      dots.push(d);
    }
    const cloudMat = track(new THREE.SpriteMaterial({ map: softTex, color: 0x8a95a0, transparent: true, opacity: 0, depthWrite: false }));
    const errorCloud = new THREE.Sprite(cloudMat);
    errorCloud.position.set(0, BODY_LIFT + BODY_RY + 0.42, 0);
    errorCloud.scale.set(0.5, 0.32, 1);
    root.add(errorCloud);
    const SPARKLE_COUNT = 5;
    const sparkles: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; dir: THREE.Vector3 }[] = [];
    const sparkleRand = mulberry32(777);
    for (let i = 0; i < SPARKLE_COUNT; i++) {
      const m = track(new THREE.SpriteMaterial({ map: softTex, color: 0x7fe0a8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      const s = new THREE.Sprite(m);
      s.scale.setScalar(0.1);
      root.add(s);
      sparkles.push({
        sprite: s,
        mat: m,
        dir: new THREE.Vector3(sparkleRand() * 2 - 1, 0.6 + sparkleRand() * 0.7, sparkleRand() * 0.6 - 0.3).normalize(),
      });
    }

    // -----------------------------------------------------------------------
    // Live tuning application (no rebuild; sliders stay smooth).
    // -----------------------------------------------------------------------
    const applyFaceLayout = (t: BotTuning) => {
      for (const e of [eyeL, eyeR]) {
        e.group.position.y = EYE_BASE_Y + t.eyeHeight;
        e.group.scale.setScalar(t.eyeSize);
      }
      beak.position.y = EYE_BASE_Y + t.eyeHeight + BEAK_Y_OFFSET;
      mouth.position.y = EYE_BASE_Y + t.eyeHeight + BEAK_Y_OFFSET;
      beak.visible = t.faceStyle === "beak";
      mouth.visible = t.faceStyle === "mouth";
      for (const c of cheeks) {
        c.visible = t.cheeks;
        c.position.y = EYE_BASE_Y + t.eyeHeight + CHEEK_Y_OFFSET;
      }
    };
    let currentMaterialStyle = tuningRef.current.materialStyle;
    const applyTuning = (t: BotTuning) => {
      paintBody(bodyGeo, t.bodyGreen, t.bellyCoverage);
      if (t.materialStyle !== currentMaterialStyle) {
        currentMaterialStyle = t.materialStyle;
        mats = makeMaterials(t.materialStyle, toonGradient);
        const newBody = track(mats.body);
        bodyMesh.material = newBody;
        bodyMat = newBody;
        const newFlipper = track(mats.solid(t.bodyGreen));
        flipperL.children[0] && ((flipperL.children[0] as THREE.Mesh).material = newFlipper);
        flipperR.children[0] && ((flipperR.children[0] as THREE.Mesh).material = newFlipper);
        flipperMat = newFlipper;
        const fc = new THREE.Color(t.bodyGreen).multiplyScalar(FEET_TINT);
        const newFeet = track(mats.solid(`#${fc.getHexString()}`));
        for (const f of feet) f.material = newFeet;
        feetMat = newFeet;
        const ac = new THREE.Color(t.bodyGreen).multiplyScalar(ANTENNA_TINT);
        const newAntenna = track(mats.solid(`#${ac.getHexString()}`));
        stem.material = newAntenna;
        tip.material = newAntenna;
        antennaMat = newAntenna;
      } else {
        const setColor = (m: THREE.Material, hex: THREE.Color) => {
          (m as THREE.MeshPhysicalMaterial).color.copy(hex);
        };
        setColor(flipperMat, new THREE.Color(t.bodyGreen));
        setColor(feetMat, new THREE.Color(t.bodyGreen).multiplyScalar(FEET_TINT));
        setColor(antennaMat, new THREE.Color(t.bodyGreen).multiplyScalar(ANTENNA_TINT));
      }
      applyFaceLayout(t);
    };
    applyTuningRef.current = applyTuning;
    applyFaceLayout(tuningRef.current);

    // -----------------------------------------------------------------------
    // Animation. Continuous values ease toward per-state targets; one-shot
    // beats (success jump, blink) run on small local timelines.
    // -----------------------------------------------------------------------
    const rand = mulberry32(20260819);
    let nextBlinkAt = performance.now() + 2000;
    let blinkQueue = 0;
    let blinkStart = 0;
    let nextShiftAt = performance.now() + 4000;
    let shiftDir = 1;
    let hovered = false;
    const gaze = new THREE.Vector2(0, 0);

    const cur = {
      squash: 1, // scale-Y factor; X/Z compensate for volume
      y: 0,
      rotZ: 0,
      rotX: 0,
      rotY: 0, // antic body turn (spin, look-around, cursor follow)
      flipL: FLIP_REST,
      flipR: -FLIP_REST,
      eyeArc: 0, // 0 open eyes, 1 happy arcs (crossfaded by visibility swap at 0.5)
      eyeSad: 0, // 0..1 outer-corner-down rotation
      eyeOpen: 1, // blink scale
      dotsOpacity: 0,
      cloudOpacity: 0,
      hoverScale: 1,
    };

    const setEyes = (arc: boolean) => {
      eyeL.open.visible = !arc;
      eyeR.open.visible = !arc;
      eyeL.arc.visible = arc;
      eyeR.arc.visible = arc;
    };

    let sparkleStart = -1;

    // -----------------------------------------------------------------------
    // ANTICS ENGINE. Idle-only by default; real states always win: an antic
    // in progress fades out over ~250ms instead of cutting. Never the same
    // antic twice in a row.
    // -----------------------------------------------------------------------
    let activeAntic: AnticDef | null = null;
    let anticStart = 0;
    let anticSeed = 0;
    let anticFade = 0;
    let anticForced = false; // /bot-test buttons play even outside idle
    let lastAnticName = "";
    let nextAnticAt = performance.now() + 5000;
    const pickAntic = (prof: BotProfile): AnticDef => {
      const pool = ANTICS.filter((a) => a.name !== lastAnticName);
      const weights = pool.map((a) => a.weight * (prof.anticWeights[a.name] ?? 1));
      const total = weights.reduce((s, w) => s + w, 0);
      let r = rand() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return pool[i];
      }
      return pool[pool.length - 1];
    };
    const startAntic = (def: AnticDef, forced: boolean) => {
      activeAntic = def;
      anticStart = performance.now();
      anticSeed = rand();
      anticForced = forced;
      lastAnticName = def.name;
    };

    // -----------------------------------------------------------------------
    // WADDLE ENGINE. Wanders a short distance during idle, stays inside the
    // container with a margin, and every target is pulled toward center so it
    // never parks in a corner.
    // -----------------------------------------------------------------------
    let posX = 0;
    let posZ = 0;
    let yaw = 0;
    let walkPhase = 0;
    let walkAmp = 0; // eases 0..1 so the waddle starts and stops softly
    let wandering = false;
    let wanderX = 0;
    let wanderZ = 0;
    let nextWanderAt = performance.now() + 4000;
    const feetBaseY = feet.map((f) => f.position.y);

    registerApi?.({
      fireAntic: (name: string) => {
        const def = ANTICS.find((a) => a.name === name);
        if (def && !reducedMotion) startAntic(def, true);
      },
      antics: ANTICS.map((a) => a.name),
    });

    let raf = 0;
    let disposed = false;
    let lastT = performance.now();
    let lastState: SchedulerBotState = stateRef.current;

    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      const t = tuningRef.current;
      const s = stateRef.current;
      if (s !== lastState) {
        lastState = s;
        if (s === "success") sparkleStart = -1;
      }
      const sinceEntry = (now - stateEnteredAtRef.current) / 1000;
      // Personality: a coefficient set over the same parameters. When the lab
      // is actually working (loading/thinking), focus wins the coefficients.
      const profName: BotProfileName = PROFILE_FOLLOWS_LAB_STATE && (s === "loading" || s === "thinking") ? "focused" : t.profile;
      const prof = PROFILES[profName];
      const k = 1 - Math.exp(-POSE_RATE * prof.poseRateMult * dt); // ~250ms crossfade

      // Per-state targets.
      let tgSquash = 1;
      let tgY = 0;
      let tgRotZ = 0;
      let tgRotX = 0;
      let tgFlipL = FLIP_REST;
      let tgFlipR = -FLIP_REST;
      let tgArc = 0;
      let tgSad = 0;
      let tgDots = 0;
      let tgCloud = 0;

      const breath = 1 + BREATH_AMPLITUDE * 0.5 * (1 + Math.sin((now / 1000 / (BREATH_PERIOD_S / Math.max(0.2, t.breathingSpeed * prof.breathMult))) * Math.PI * 2));

      if (s === "idle") {
        tgSquash = breath;
        if (now > nextShiftAt) {
          nextShiftAt = now + (WEIGHT_SHIFT_S + (rand() * 4 - 2)) * 1000;
          shiftDir = -shiftDir;
        }
        tgRotZ = shiftDir * WEIGHT_SHIFT_RAD;
        tgFlipL = FLIP_REST + 0.05 * Math.sin(now / 1300);
        tgFlipR = -FLIP_REST - 0.05 * Math.sin(now / 1300 + 1.1);
      } else if (s === "thinking") {
        tgSquash = breath;
        tgRotX = -THINK_TILT_RAD * 0.7; // lean back
        tgRotZ = THINK_TILT_RAD; // tilt
        tgFlipR = -2.15; // one flipper toward the chin
        tgDots = 1;
      } else if (s === "loading") {
        const p = (sinceEntry % LOAD_BOUNCE_PERIOD_S) / LOAD_BOUNCE_PERIOD_S;
        tgY = t.bounceAmplitude * LOAD_BOUNCE_HEIGHT * 4 * p * (1 - p);
        const impact = Math.exp(-Math.pow(Math.min(p, 1 - p) / 0.07, 2));
        tgSquash = 1 + 0.08 * Math.sin(Math.PI * p) - LOAD_SQUASH * impact;
        tgArc = 1;
        const flap = 0.32 * Math.sin(Math.PI * 2 * p);
        tgFlipL = FLIP_REST + 0.25 + flap;
        tgFlipR = -FLIP_REST - 0.25 - flap;
      } else if (s === "success") {
        const p = Math.min(1, sinceEntry / SUCCESS_TOTAL_S);
        tgArc = 1;
        tgFlipL = 2.45; // V pose
        tgFlipR = -2.45;
        if (p < 0.18) {
          const q = easeInOutCubic(p / 0.18);
          tgSquash = 1 - 0.15 * q; // anticipation crouch
        } else if (p < 0.55) {
          const q = easeOutCubic((p - 0.18) / 0.37);
          tgY = t.bounceAmplitude * SUCCESS_JUMP * q;
          tgSquash = 0.85 + 0.27 * q; // stretch at the apex
          if (sparkleStart < 0 && p > 0.4) sparkleStart = now;
        } else if (p < 0.82) {
          const q = easeInCubic((p - 0.55) / 0.27);
          tgY = t.bounceAmplitude * SUCCESS_JUMP * (1 - q);
          tgSquash = 1.12 - 0.24 * q; // land into squash
        } else {
          tgSquash = 0.88 + 0.12 * easeOutCubic((p - 0.82) / 0.18);
        }
        if (p >= 1) {
          tgArc = 0;
          tgFlipL = FLIP_REST;
          tgFlipR = -FLIP_REST;
          tgSquash = breath;
        }
      } else if (s === "error") {
        tgSquash = ERROR_DEFLATE + 0.015 * Math.sin((sinceEntry / ERROR_BOB_S) * Math.PI * 2); // deflated slow bob
        tgFlipL = 0.1; // drooped
        tgFlipR = -0.1;
        tgSad = 1;
        tgCloud = 1;
      }

      // ---------------------------------------------------------------------
      // WADDLE (idle only; real states pull the bot back toward center).
      // ---------------------------------------------------------------------
      let wRoll = 0;
      let wBob = 0;
      let wLean = 0;
      let wFlip = 0;
      let wSquash = 0;
      let footL = 0;
      let footR = 0;
      let targetYaw = 0;
      const waddling = s === "idle" && t.waddle && !reducedMotion && !activeAntic;
      if (waddling && !wandering && now >= nextWanderAt) {
        const R = Math.max(0.1, t.wanderRadius * prof.wanderMult);
        // Center pull: targets shrink toward 0 so it never parks in a corner.
        wanderX = Math.max(-(R - WANDER_MARGIN), Math.min(R - WANDER_MARGIN, (rand() * 2 - 1) * R * (1 - WANDER_CENTER_PULL)));
        wanderZ = (rand() * 2 - 1) * R * WANDER_Z_FACTOR * (1 - WANDER_CENTER_PULL);
        wandering = true;
      }
      if (wandering && waddling) {
        const dx = wanderX - posX;
        const dz = wanderZ - posZ;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.03) {
          if (rand() < WANDER_CHAIN_PROB) {
            // Chain into another leg: a direction change mid-wander.
            const R = Math.max(0.1, t.wanderRadius * prof.wanderMult);
            wanderX = Math.max(-(R - WANDER_MARGIN), Math.min(R - WANDER_MARGIN, (rand() * 2 - 1) * R * (1 - WANDER_CENTER_PULL)));
            wanderZ = (rand() * 2 - 1) * R * WANDER_Z_FACTOR * (1 - WANDER_CENTER_PULL);
          } else {
            wandering = false;
            nextWanderAt = now + (WANDER_INTERVAL_S_MIN + rand() * (WANDER_INTERVAL_S_MAX - WANDER_INTERVAL_S_MIN)) * 1000;
          }
        } else {
          const sp = WADDLE_MOVE_SPEED * t.waddleSpeed * prof.waddleSpeedMult;
          const step = Math.min(dist, sp * dt);
          posX += (dx / dist) * step;
          posZ += (dz / dist) * step;
          walkAmp += (1 - walkAmp) * Math.min(1, dt * 5); // ease into the walk
          targetYaw = Math.max(-WADDLE_MAX_YAW, Math.min(WADDLE_MAX_YAW, Math.atan2(dx, 0.9)));
        }
      } else {
        walkAmp += (0 - walkAmp) * Math.min(1, dt * 4); // settle softly
        if (s !== "idle") {
          wandering = false;
          posX += (0 - posX) * Math.min(1, dt * 2);
          posZ += (0 - posZ) * Math.min(1, dt * 2);
        }
      }
      if (walkAmp > 0.01) {
        walkPhase += dt * Math.PI * 2 * WADDLE_STEP_HZ * t.waddleSpeed * prof.waddleSpeedMult;
        const rollRad = ((t.waddleRollDeg * Math.PI) / 180) * prof.waddleAmplMult;
        const sPh = Math.sin(walkPhase);
        wRoll = sPh * rollRad * walkAmp;
        wBob = Math.abs(sPh) * WADDLE_BOB * prof.waddleAmplMult * walkAmp;
        wSquash = -0.05 * Math.pow(1 - Math.abs(sPh), 6) * walkAmp; // squash on each plant
        wLean = -WADDLE_LEAN * walkAmp; // lean into the walk
        wFlip = Math.sin(walkPhase + Math.PI) * WADDLE_FLIPPER_SWING * walkAmp; // counter-swing
        footL = Math.max(0, sPh) * WADDLE_FOOT_LIFT * walkAmp;
        footR = Math.max(0, -sPh) * WADDLE_FOOT_LIFT * walkAmp;
      }
      yaw += (targetYaw - yaw) * Math.min(1, dt * WADDLE_TURN_RATE);
      // Hard bound: the bot is always fully visible in its home region.
      {
        const maxR = Math.max(0.1, t.wanderRadius * prof.wanderMult);
        posX = Math.max(-maxR, Math.min(maxR, posX));
        posZ = Math.max(-maxR * WANDER_Z_FACTOR, Math.min(maxR * WANDER_Z_FACTOR, posZ));
      }

      // ---------------------------------------------------------------------
      // ANTICS (idle only unless fired from /bot-test). Real states always
      // win: the fade takes an in-progress antic out over ~250ms.
      // ---------------------------------------------------------------------
      if (s === "idle" && !reducedMotion && !activeAntic && now >= nextAnticAt && t.anticFrequency > 0) {
        startAntic(pickAntic(prof), false);
        nextAnticAt =
          now +
          (((ANTIC_INTERVAL_S_MIN + rand() * (ANTIC_INTERVAL_S_MAX - ANTIC_INTERVAL_S_MIN)) * prof.anticIntervalMult) /
            Math.max(0.1, t.anticFrequency)) *
            1000;
      }
      let aPose: AnticPose = {};
      const anticAllowed = activeAntic !== null && (s === "idle" || anticForced);
      anticFade += ((anticAllowed ? 1 : 0) - anticFade) * Math.min(1, dt * ANTIC_FADE_RATE);
      if (activeAntic) {
        const ap = (now - anticStart) / (activeAntic.duration * 1000);
        if (ap >= 1) {
          activeAntic = null;
          anticForced = false;
        } else {
          aPose = activeAntic.pose(ap, anticSeed);
          if (!anticAllowed && anticFade < 0.02) {
            activeAntic = null;
            anticForced = false;
            aPose = {};
          }
        }
      }
      const af = anticFade;
      if (aPose.sparkle && now - sparkleStart > 700) sparkleStart = now;

      // Compose waddle + antic over the state targets.
      tgSquash += wSquash + (aPose.squashDelta ?? 0) * af;
      tgY += wBob + (aPose.y ?? 0) * af;
      tgRotZ += wRoll + (aPose.rotZ ?? 0) * af;
      tgRotX += wLean + (aPose.rotX ?? 0) * af;
      tgFlipL += wFlip + (aPose.flipL ?? 0) * af;
      tgFlipR += wFlip + (aPose.flipR ?? 0) * af;
      const tgRotY = (aPose.rotY ?? 0) * af + gaze.x * 0.45 * (aPose.gazeFollow ?? 0) * af;

      // Ease everything (crossfade, never cut).
      cur.squash += (tgSquash - cur.squash) * k;
      cur.y += (tgY - cur.y) * (s === "loading" || s === "success" ? 1 : k); // timeline states own their y exactly
      cur.rotZ += (tgRotZ - cur.rotZ) * k;
      cur.rotX += (tgRotX - cur.rotX) * k;
      cur.rotY += (tgRotY - cur.rotY) * k;
      cur.flipL += (tgFlipL - cur.flipL) * k;
      cur.flipR += (tgFlipR - cur.flipR) * k;
      cur.eyeArc += (tgArc - cur.eyeArc) * k;
      cur.eyeSad += (tgSad - cur.eyeSad) * k;
      cur.dotsOpacity += (tgDots - cur.dotsOpacity) * k;
      cur.cloudOpacity += (tgCloud - cur.cloudOpacity) * k;
      cur.hoverScale += ((hovered ? HOVER_SCALE : 1) - cur.hoverScale) * k;

      // Blink scheduling (idle and thinking only; error holds lids low).
      if (s === "idle" || s === "thinking") {
        if (now >= nextBlinkAt && blinkQueue === 0) {
          blinkQueue = rand() < DOUBLE_BLINK_CHANCE ? 2 : 1;
          blinkStart = now;
          nextBlinkAt = now + ((BLINK_MIN_S + rand() * (BLINK_MAX_S - BLINK_MIN_S)) * 1000) / prof.blinkMult;
        }
      }
      let eyeOpenTarget = 1;
      if (blinkQueue > 0) {
        const bp = (now - blinkStart) / 1000;
        const one = BLINK_CLOSE_S * 2;
        if (bp < BLINK_CLOSE_S) eyeOpenTarget = 1 - easeInOutCubic(bp / BLINK_CLOSE_S);
        else if (bp < one) eyeOpenTarget = easeInOutCubic((bp - BLINK_CLOSE_S) / BLINK_CLOSE_S);
        else {
          blinkQueue -= 1;
          blinkStart = now + 70; // beat between the two blinks of a pair
        }
      }
      if (s === "error") eyeOpenTarget = 0.55; // heavy-lidded sad
      if (aPose.eyesClosed) eyeOpenTarget = Math.min(eyeOpenTarget, 1 - aPose.eyesClosed * af);
      cur.eyeOpen += (eyeOpenTarget - cur.eyeOpen) * Math.min(1, dt * 40);

      // Apply pose. Squash preserves volume: X/Z widen as Y compresses. The
      // waddle owns root x/z; the yaw turns the whole content group.
      const sq = Math.max(0.5, cur.squash);
      const xz = cur.hoverScale / Math.sqrt(sq);
      root.scale.set(xz, sq * cur.hoverScale, xz);
      root.position.set(posX + (aPose.x ?? 0) * af, GROUND_Y + cur.y, posZ);
      content.rotation.y = yaw;
      lean.rotation.z = cur.rotZ;
      lean.rotation.x = cur.rotX;
      lean.rotation.y = cur.rotY;
      flipperL.rotation.z = cur.flipL;
      flipperR.rotation.z = cur.flipR;
      feet[0].position.y = feetBaseY[0] + footL;
      feet[1].position.y = feetBaseY[1] + footR;

      // Eyes: arcs crossfade with open eyes at the halfway point; sad tilts
      // outer corners down; gaze shifts the whole face subtly (antic
      // cursor-follow boosts the gaze weight).
      setEyes(cur.eyeArc > 0.5);
      const gazeBoost = 1 + 3 * (aPose.gazeFollow ?? 0) * af;
      const thinkLook = s === "thinking" ? 0.06 : 0;
      for (const e of [eyeL, eyeR]) {
        e.open.scale.y = Math.max(0.06, cur.eyeOpen);
        e.group.rotation.z = e.side * -0.24 * cur.eyeSad;
        e.group.position.x = e.side * EYE_SPACING + gaze.x * GAZE_RANGE * gazeBoost - (s === "thinking" ? 0.03 : 0);
        e.group.position.y = EYE_BASE_Y + t.eyeHeight + gaze.y * GAZE_RANGE * gazeBoost + thinkLook;
      }

      // Effects.
      for (let i = 0; i < dots.length; i++) {
        dotMats[i].opacity = cur.dotsOpacity * (0.35 + 0.3 * Math.sin(now / 400 + i * 0.9));
        dots[i].position.y = BODY_LIFT + 0.72 + i * 0.12 + 0.02 * Math.sin(now / 600 + i);
      }
      cloudMat.opacity = cur.cloudOpacity * 0.55;
      errorCloud.position.y = BODY_LIFT + BODY_RY + 0.42 + 0.02 * Math.sin(now / 900);
      if (sparkleStart > 0) {
        const sp = (now - sparkleStart) / 600;
        if (sp > 1) sparkleStart = 0;
        else {
          for (const sk of sparkles) {
            sk.mat.opacity = 0.9 * Math.min(1.5, prof.sparkleMult) * (1 - easeInCubic(sp));
            sk.sprite.position.copy(sk.dir).multiplyScalar(0.6 + sp * 0.9);
            sk.sprite.position.y += BODY_LIFT + 0.4;
            sk.sprite.scale.setScalar(0.08 + 0.1 * easeOutCubic(sp));
          }
        }
      } else {
        for (const sk of sparkles) sk.mat.opacity = 0;
      }

      // Shadow follows squash and altitude.
      const jumpNorm = clamp01(cur.y / (SUCCESS_JUMP || 1));
      shadow.position.set(posX, GROUND_Y + 0.005, 0.1 + posZ); // the shadow travels with the waddle
      shadow.scale.set(1.5 * (1 + (1 - sq) * 0.6) * (1 - 0.22 * jumpNorm), 1.0 * (1 + (1 - sq) * 0.6) * (1 - 0.22 * jumpNorm), 1);
      shadowMat.opacity = SHADOW_OPACITY * (1 - 0.55 * jumpNorm);

      renderer.render(scene, camera);
    };

    // Reduced motion: one static pose per state, no loop.
    const renderStatic = () => {
      const st = stateRef.current;
      cur.hoverScale = 1;
      lean.rotation.set(0, 0, 0);
      flipperL.rotation.z = FLIP_REST;
      flipperR.rotation.z = -FLIP_REST;
      setEyes(st === "loading" || st === "success");
      eyeL.open.scale.y = 1;
      eyeR.open.scale.y = 1;
      cloudMat.opacity = st === "error" ? 0.55 : 0;
      for (const m of dotMats) m.opacity = st === "thinking" ? 0.5 : 0;
      if (st === "thinking") {
        lean.rotation.z = THINK_TILT_RAD;
        flipperR.rotation.z = -2.15;
      } else if (st === "success") {
        flipperL.rotation.z = 2.45;
        flipperR.rotation.z = -2.45;
      } else if (st === "error") {
        root.scale.set(1.02, ERROR_DEFLATE, 1.02);
        flipperL.rotation.z = 0.1;
        flipperR.rotation.z = -0.1;
        eyeL.group.rotation.z = 0.24;
        eyeR.group.rotation.z = -0.24;
      }
      renderer.render(scene, camera);
    };

    const onPointerMove = (ev: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      gaze.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      gaze.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    };
    const onEnter = () => {
      hovered = true;
    };
    const onLeave = () => {
      hovered = false;
      gaze.set(0, 0);
    };

    if (!reducedMotion) {
      mount.addEventListener("pointermove", onPointerMove);
      mount.addEventListener("pointerenter", onEnter);
      mount.addEventListener("pointerleave", onLeave);
      animate();
    } else {
      renderStatic();
      const interval = window.setInterval(() => {
        if (lastState !== stateRef.current) {
          lastState = stateRef.current;
          renderStatic();
        }
      }, 250);
      disposables.push({ dispose: () => window.clearInterval(interval) });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (!reducedMotion) {
        mount.removeEventListener("pointermove", onPointerMove);
        mount.removeEventListener("pointerenter", onEnter);
        mount.removeEventListener("pointerleave", onLeave);
      }
      applyTuningRef.current = null;
      registerApi?.(null);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // The scene mounts once per size; state and tuning flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  return (
    <div
      ref={mountRef}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={title ?? `scheduler status: ${state}`}
      title={title ?? `scheduler: ${state}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      className={onClick ? "cursor-pointer" : undefined}
      style={{ width: size, height: size }}
    />
  );
}
