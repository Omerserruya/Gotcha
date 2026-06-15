/**
 * Phase 1 - Live Call CoPilot post-call pipeline.
 *
 * Two pieces:
 *   - subscriber: reacts to voice.session.ended / voice.session.state events
 *     and seeds the pipeline (upserts row + enqueues advance job).
 *   - advance-worker: walks the row forward through PostCallStage stages.
 *
 * Bootstrap from services/ai/src/index.ts via startVoicePostCallWorker().
 */

import { startVoicePostCallSubscriber, stopVoicePostCallSubscriber } from "./subscriber";
import {
  startVoicePostCallAdvanceWorker,
  stopVoicePostCallAdvanceWorker,
} from "./advance-worker";

export function startVoicePostCallWorker(): void {
  startVoicePostCallAdvanceWorker();
  startVoicePostCallSubscriber();
}

export async function stopVoicePostCallWorker(): Promise<void> {
  await stopVoicePostCallSubscriber();
  await stopVoicePostCallAdvanceWorker();
}

export { advanceVoicePostCall } from "./advance-worker";
export {
  VOICE_POSTCALL_QUEUE_NAME,
  VOICE_POSTCALL_JOB_NAME,
  getVoicePostCallQueue,
  type VoicePostCallJobData,
} from "./queue";
