export {
  approvalRequiredFor,
  describeTask,
  detectStaleStates,
  estimateTaskCost,
  PRIORITY,
  type CorpusSnapshot,
  type DetectedDiagnostic,
  type DetectedTask,
  type DetectionResult,
  type DetectionStats,
  type LibrarySnapshot,
  type TaskKind,
} from "./detection";
export { buildCorpusSnapshot } from "./snapshot";
export { scheduleApprovableRun, type ScheduleSummary, type ScheduledTaskSummary } from "./schedule";
export {
  claimTask,
  deriveRunStatus,
  executeApprovedTasks,
  reapStaleExecutions,
  syncRunStatus,
  type ExecutionReport,
  type TaskExecutionResult,
} from "./execute";
export { extractMetricsMultiLibrary, DEFAULT_FAN_OUT_LIBRARIES, type FanOutReport } from "./fan-out";
