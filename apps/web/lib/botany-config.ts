// ---------------------------------------------------------------------------
// BOTANY CONFIG: every tunable of the tree generator lives here, nothing in
// the generator itself. /botany-test exposes ALL of these as live controls;
// the human tunes by eye and bakes keepers back into these defaults via the
// page's "copy config" diff.
//
// The generator is deterministic: same library (same seed, same data, same
// config) = same tree, every render.
// ---------------------------------------------------------------------------

export type BotanyConfig = {
  // MAPPING: paper count -> size.
  branchCountBase: number; // primary branches at zero papers
  branchPerPapers: number; // one more primary branch per this many papers
  branchCountMax: number;
  heightBase: number; // world-units trunk height floor
  heightPerPaper: number; // height gained per paper
  heightMax: number;
  trunkRadiusBase: number;
  trunkRadiusPerPaper: number;
  trunkRadiusMax: number;
  // MAPPING: internal citation density (avg internal edges per paper) ->
  // branching complexity and canopy fullness.
  densityDepthT1: number; // density above this adds one recursion level
  densityDepthT2: number; // and above this, another
  depthBase: number;
  depthMax: number;
  childrenBase: number; // child branches per node at zero density
  childrenDensityMult: number; // extra children scaled by density
  childrenMax: number;
  canopyDensityBase: number; // leaf fullness floor
  canopyDensityFromCitations: number; // fullness added by citation density
  // MAPPING: pipeline state -> health and ornaments.
  budScale: number; // bare (unsynthesized) trees carry buds at this scale
  budFraction: number; // fraction of tips that carry a bud when bare
  criticLeafDensity: number; // leaf density multiplier when critic is missing
  criticDesat: number; // foliage desaturation when critic is missing (0..1)
  fruitBuckets: readonly number[]; // metric-row thresholds -> fruit bucket
  fruitPerBucket: number; // fruit count per bucket step
  blossomCount: number; // blossoms when cross-domain is done
  glowOpacity: number; // canopy glow sprites when experiment+document done
  communityMix: number; // how much community hue tints the foliage (0..1)
  // FORM: the organic shape.
  branchAngle: number; // radians a child leaves its parent
  angleJitter: number; // seeded jitter on that angle
  goldenAngle: number; // phyllotaxis azimuth step (radians)
  lengthRatio: number; // child length vs parent
  radiusRatio: number; // child radius vs parent
  taper: number; // tip radius vs base radius along one branch
  curvature: number; // per-segment organic bend
  gravityBias: number; // upward pull per segment (keeps trees reaching)
  segmentsPerBranch: number; // polyline segments per branch (curvature detail)
  minBranchLength: number; // recursion stops below this
  // HARD GEOMETRY BUDGET: dense libraries (high citation density) would
  // otherwise explode combinatorially; growth stops gracefully at the caps
  // (outermost branches become tips), keeping every tree forest-cheap.
  maxBranchSegments: number;
  maxTips: number;
  leavesPerTip: number;
  leafSize: number;
  leafJitter: number; // positional scatter of leaves around a tip
  fruitSize: number;
  blossomSize: number;
  // MATERIALS (render quality; the data mapping is untouched by these).
  barkRoughness: number; // lower = waxier bark
  barkVariation: number; // seeded per-segment tone variation (0..1)
  branchRadialSegments: number; // radial smoothness of trunk/branch cylinders
  leafTranslucency: number; // emissive rim strength; the subsurface feel
  leafColorSpread: number; // per-leaf variation around the community hue
  leafOpacity: number;
  leafGlowOpacity: number; // soft additive canopy layer; 0 disables it
  fruitRoughness: number;
  fruitEmissive: number;
  blossomRoughness: number;
  blossomEmissive: number;
  // LIGHTING RIG AND ATMOSPHERE.
  lightKeyColor: string; // warm key
  lightFillColor: string; // cool fill
  lightRimColor: string; // soft rim/back so silhouettes separate
  lightKeyAzimuthDeg: number; // rotates the key around the forest
  contactShadowOpacity: number; // soft radial decal at each base (planted feel)
  contactShadowScale: number; // shadow radius vs tree height
  fogDensity: number; // distant trees recede
  mistOpacity: number; // faint ground mist; 0 disables
  mistHeight: number; // mist plane height above the floor
  bloomStrength: number; // subtle bloom on bright glow/fruit; 0 disables
  bloomRadius: number;
  bloomThreshold: number; // high threshold keeps bloom off foliage
  // MOTION AND SCENE.
  swayAmount: number; // radians of idle wind sway (reduced-motion disables)
  swaySpeed: number; // sway cycles per second-ish
  motesCount: number; // ambient life particles per scene
  motesOpacity: number;
  branchColor: string; // warm dark bark that reads on the dark ground
  barkTipColor: string; // younger growth at branch tips
  budColor: string; // bare-tree bud color (life waiting, not an error)
  fruitColor: string;
  blossomColor: string;
  glowColor: string;
  lightKey: number;
  lightFill: number;
  lightRim: number;
  lightAmbient: number;
  groundColor: string; // scene floor disc
  // BRIDGES: cross-domain links as connecting growth.
  bridgeBaseRadius: number; // tube radius at strength 1
  bridgeRadiusPerLink: number;
  bridgeOpacityBase: number;
  bridgeOpacityPerLink: number;
  bridgeArcHeight: number; // vine arc lift as a fraction of tree distance
};

export const BOTANY_DEFAULTS: BotanyConfig = {
  branchCountBase: 3,
  branchPerPapers: 4,
  branchCountMax: 12,
  heightBase: 1.6,
  heightPerPaper: 0.05,
  heightMax: 3.4,
  trunkRadiusBase: 0.07,
  trunkRadiusPerPaper: 0.003,
  trunkRadiusMax: 0.17,
  densityDepthT1: 0.5,
  densityDepthT2: 1.5,
  depthBase: 2,
  depthMax: 4,
  childrenBase: 2,
  childrenDensityMult: 1.4,
  childrenMax: 4,
  canopyDensityBase: 0.55,
  canopyDensityFromCitations: 0.45,
  budScale: 0.35,
  budFraction: 0.4,
  criticLeafDensity: 0.5,
  criticDesat: 0.45,
  fruitBuckets: [1, 100, 400, 800],
  fruitPerBucket: 3,
  blossomCount: 9,
  glowOpacity: 0.4,
  communityMix: 0.35,
  branchAngle: 0.62,
  angleJitter: 0.16,
  goldenAngle: 2.39996323,
  lengthRatio: 0.72,
  radiusRatio: 0.62,
  taper: 0.6,
  curvature: 0.2,
  gravityBias: 0.14,
  segmentsPerBranch: 4,
  minBranchLength: 0.16,
  maxBranchSegments: 900,
  maxTips: 320,
  leavesPerTip: 5,
  leafSize: 0.11,
  leafJitter: 0.1,
  fruitSize: 0.04,
  blossomSize: 0.05,
  barkRoughness: 0.85,
  barkVariation: 0.18,
  branchRadialSegments: 10,
  leafTranslucency: 0.35,
  leafColorSpread: 0.16,
  leafOpacity: 0.92,
  leafGlowOpacity: 0.18,
  fruitRoughness: 0.3,
  fruitEmissive: 0.25,
  blossomRoughness: 0.45,
  blossomEmissive: 0.4,
  lightKeyColor: "#ffe9cf",
  lightFillColor: "#cfe2ff",
  lightRimColor: "#eafff2",
  lightKeyAzimuthDeg: 38,
  contactShadowOpacity: 0.42,
  contactShadowScale: 1.1,
  fogDensity: 0.035,
  mistOpacity: 0.12,
  mistHeight: 0.5,
  bloomStrength: 0.35,
  bloomRadius: 0.6,
  bloomThreshold: 0.75,
  swayAmount: 0.02,
  swaySpeed: 0.45,
  motesCount: 42,
  motesOpacity: 0.35,
  branchColor: "#575043",
  barkTipColor: "#6d6553",
  budColor: "#7fae8f",
  fruitColor: "#e8c069",
  blossomColor: "#f2dbe4",
  glowColor: "#8ff0bc",
  lightKey: 1.25,
  lightFill: 0.5,
  lightRim: 0.9,
  lightAmbient: 0.35,
  groundColor: "#10160f",
  bridgeBaseRadius: 0.02,
  bridgeRadiusPerLink: 0.008,
  bridgeOpacityBase: 0.3,
  bridgeOpacityPerLink: 0.08,
  bridgeArcHeight: 0.35,
};
