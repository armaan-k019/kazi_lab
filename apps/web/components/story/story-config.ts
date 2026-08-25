// ---------------------------------------------------------------------------
// STORY CONFIG: the narrative's scene arc, camera keyframes, and tunables.
// Scenes are camera and content states along ONE continuous journey on ONE
// canvas; scroll progress (0..1) drives everything. All real numbers in the
// scenes come from the live read APIs; nothing here is content, only shape.
// ---------------------------------------------------------------------------

export type SceneId = "hero" | "corpus" | "worlds" | "bridges" | "next" | "enter";

export type StoryScene = {
  id: SceneId;
  lengthVh: number; // scroll length of this chapter (viewport heights)
};

// The arc. worlds gets double length: the forest traverse is the emotional
// core and deserves the scroll room.
export const SCENES: StoryScene[] = [
  { id: "hero", lengthVh: 100 },
  { id: "corpus", lengthVh: 100 },
  { id: "worlds", lengthVh: 200 },
  { id: "bridges", lengthVh: 120 },
  { id: "next", lengthVh: 100 },
  { id: "enter", lengthVh: 100 },
];

export type CameraKeyframe = { p: number; pos: [number, number, number]; look: [number, number, number] };

// Camera keyframes over normalized progress. The forest sits along x
// (TREE_SPACING apart); the journey approaches, traverses, rises to the
// bridges, settles at the scheduler, and returns to the door.
export const CAMERA_KEYFRAMES: CameraKeyframe[] = [
  { p: 0.0, pos: [0, 1.7, 15], look: [0, 1.6, 0] }, // hero: the forest in the distance
  { p: 0.14, pos: [0, 2.8, 11], look: [0, 1.4, 0] }, // corpus: scope reveals
  { p: 0.28, pos: [-6.4, 1.5, 4.6], look: [-4.5, 1.5, 0] }, // worlds: enter at the first tree
  { p: 0.52, pos: [6.4, 1.5, 4.6], look: [4.5, 1.5, 0] }, // worlds: traverse to the last
  { p: 0.68, pos: [0, 7.2, 8.5], look: [0, 2.4, 0] }, // bridges: rise above the canopy
  { p: 0.84, pos: [2.6, 2.1, 6.5], look: [0, 1.4, 0] }, // next: settle near the ground
  { p: 1.0, pos: [0, 1.9, 10], look: [0, 1.6, 0] }, // enter: the door
];

export const STORY = {
  treeSpacing: 3.0, // world units between trees on the line
  dprCap: 1.5, // the story renders more than the portal; cap tighter
  frameBudgetMs: 10, // above this rolling average, degrade to render-on-scroll
  lodNearDistance: 7, // trees closer than this render full detail
  swayNearOnly: true, // distant trees skip per-frame sway work
  heroTreePulse: 0.5, // gentle emissive breathing on the hero framing
  scrollEase: 0.12, // per-frame easing of camera toward the scroll target
} as const;

// Reduced-detail botany overrides for distant trees (LOD low).
export const LOD_LOW_OVERRIDES = {
  maxBranchSegments: 220,
  maxTips: 90,
  leavesPerTip: 2,
  segmentsPerBranch: 3,
} as const;
