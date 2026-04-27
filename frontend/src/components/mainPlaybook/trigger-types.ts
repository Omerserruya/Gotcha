import type { Node } from "reactflow";

export const TRIGGER_TYPES = new Set([
  "channel_entry",
  "comment_trigger",
  "keyword_trigger",
  "schedule_trigger",
]);

export function isTriggerNode(n: Pick<Node, "type">): boolean {
  return !!n.type && TRIGGER_TYPES.has(n.type);
}
