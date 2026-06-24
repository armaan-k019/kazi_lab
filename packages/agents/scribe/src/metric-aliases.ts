// Auditable canonical alias map for pooling. It MERGES ONLY genuine
// equivalents that were actually observed in the spatial data. Principle:
// under-merge over over-merge. Raw (dataset_raw/metric_raw) and normalized
// (dataset_norm/metric_norm/task) values are left untouched; these maps produce
// the additive *_canon fields used only for pooling, so every merge is auditable
// and reversible.
//
// Each entry is "observed variant" -> "canonical". Add only equivalents you are
// confident are the same entity. When unsure, leave it out (see NON-MERGES).

export const DATASET_ALIASES: Record<string, string> = {
  // "ShapeNet Part" and "ShapeNetPart" are the same part-segmentation benchmark.
  "ShapeNet Part": "ShapeNetPart",
};

export const METRIC_ALIASES: Record<string, string> = {
  // None. The extractor's metric_norm was already canonical in the spatial data
  // (e.g. "OA"/"overall accuracy" had already collapsed to "accuracy"), so no
  // metric merges are needed. Left explicit so the absence is intentional.
};

export const TASK_ALIASES: Record<string, string> = {
  // Object/shape classification are the same benchmark task in this domain.
  // NOTE: "node classification" (graph) is deliberately NOT mapped here.
  "3D object classification": "classification",
  "3D shape classification": "classification",
  "object classification": "classification",
  // Scene-level semantic segmentation on S3DIS/ScanNet.
  // NOTE: "part segmentation" and "semantic scene completion" are NOT mapped.
  "3D scene segmentation": "semantic segmentation",
};

// Deliberate NON-MERGES (kept separate on purpose; documented for audit):
// - dataset "ShapeNet" (full set, e.g. reconstruction) vs "ShapeNetPart" (part seg).
// - dataset "KITTI" vs "SemanticKITTI" (different benchmarks/tasks).
// - task "node classification" (graph) vs "classification" (3D objects).
// - task "object detection" (2D, COCO) vs "3D object detection" (KITTI/nuScenes).
// - task "semantic scene completion" vs "semantic segmentation".
// - metric "IoU" vs "mIoU" (per-class vs mean); "AP" vs "mAP".
export const DELIBERATE_NON_MERGES: string[] = [
  "dataset ShapeNet != ShapeNetPart",
  "dataset KITTI != SemanticKITTI",
  "task node classification != classification",
  "task object detection (2D) != 3D object detection",
  "task semantic scene completion != semantic segmentation",
  "metric IoU != mIoU",
  "metric AP != mAP",
];

function applyAlias(
  map: Record<string, string>,
  value: string | null,
): string | null {
  if (value == null) return value;
  return map[value] ?? map[value.trim()] ?? value;
}
export const canonDataset = (v: string | null) => applyAlias(DATASET_ALIASES, v);
export const canonMetric = (v: string | null) => applyAlias(METRIC_ALIASES, v);
export const canonTask = (v: string | null) => applyAlias(TASK_ALIASES, v);
