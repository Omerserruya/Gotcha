/**
 * Post-Call Pilot - Phase 5 ships Mode A (QA validator over live frames).
 *
 * Phase 6 will add Mode B (async transcription + analysis from a recording
 * URL or pasted transcript). Both modes write to CallAnalysis (mode = "qa"
 * or "async") and emit shared events; the runtime model differs only in
 * cadence and trigger.
 */

export { runQA } from "./qa-runner";
export {
  startPostCallQAWorker,
  stopPostCallQAWorker,
} from "./qa-worker";
export {
  startPostCallQATrigger,
  stopPostCallQATrigger,
} from "./qa-trigger";
export {
  runAsyncAnalysis,
  type AsyncRunInput,
  type AsyncRunOutput,
  type ModeBSourceSpec,
} from "./async-runner";
export {
  startPostCallAnalyzeWorker,
  stopPostCallAnalyzeWorker,
} from "./analyze-worker";
