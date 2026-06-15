/**
 * Re-export - the call state machine lives in @chatcenter/shared so both
 * voice-copilot (writer) and the conversation service (reader/claim API)
 * share a single source of truth. This file exists purely to keep the
 * existing voice-copilot import paths stable.
 */
export {
  canTransition,
  assertTransition,
  toLegacyStatus,
  fromLegacyStatus,
  appendHistory,
  makeHistoryEntry,
  InvalidTransitionError,
  TERMINAL_STATES,
  LIVE_STATES,
  type CallState,
  type LegacyCallStatus,
  type StateHistoryEntry,
} from "@chatcenter/shared";
