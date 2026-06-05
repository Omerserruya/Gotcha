import type { Node } from "reactflow";

export const TRIGGER_TYPES = new Set([
  "channel_entry",
  "comment_trigger",
  "keyword_trigger",
  "schedule_trigger",
  // Generic inbound webhook. Fires the linked workflow when an authenticated
  // POST hits the trigger's URL (services/webhook ingest → ticket 3 executor).
  "webhook_trigger",
  // Voice triggers — wired in node-registry under category "Voice Triggers".
  // Match against the live-call event surface published by voice-copilot.
  "voice_trigger:call.incoming",
  "voice_trigger:call.answered",
  "voice_trigger:call.missed",
  "voice_trigger:call.hangup_customer",
  "voice_trigger:call.hangup_agent",
  "voice_trigger:call.intent_detected",
  "voice_trigger:call.keyword_spoken",
]);

export function isTriggerNode(n: Pick<Node, "type">): boolean {
  return !!n.type && TRIGGER_TYPES.has(n.type);
}
