/**
 * Re-export — voice-session-store lives in @chatcenter/shared. Kept here as
 * a stable import path for voice-copilot internal modules.
 */
export {
  transitionVoiceCallSessionState,
  claimIncomingCall,
  agentBusyOnLiveCall,
  type TransitionFailure,
  type ClaimFailure,
} from "@chatcenter/shared";
