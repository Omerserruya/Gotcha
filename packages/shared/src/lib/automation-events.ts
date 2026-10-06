/**
 * Events that fire automations without an inbound message (Studio >
 * Automations). They ride the incoming-messages queue as "automation-event"
 * jobs; the incoming worker turns them into runs.
 *
 * Only a person's or the AI employee's write emits. An automation's own
 * add_tag does not call this - that is the loop guard for tags.
 */
import { incomingMessageQueue } from "./queue";

/** The tags in `after` that were not in `before` (case-sensitive, as stored). */
export function tagsAdded(before: unknown, after: unknown): string[] {
  const b = new Set(Array.isArray(before) ? before.map(String) : []);
  return [...new Set(Array.isArray(after) ? after.map(String) : [])].filter((t) => !b.has(t));
}

/**
 * One "tag_added" event per newly added tag. Best-effort: a queue hiccup must
 * never fail the write that already happened.
 */
export async function emitTagsAdded(tenantId: string, contactId: string, before: unknown, after: unknown): Promise<number> {
  const added = tagsAdded(before, after);
  const at = Date.now();
  for (const tag of added) {
    await incomingMessageQueue
      .add("automation-event", { tenantId, type: "tag_added", contactId, tag, eventKey: `tag:${contactId}:${tag}:${at}` }, { attempts: 3, removeOnComplete: true, removeOnFail: 100 })
      .catch((err: any) => console.warn("[automation-events] tag_added not queued:", err?.message));
  }
  return added.length;
}
