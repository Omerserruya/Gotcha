/**
 * Copilot suggestions on a customer message - the trigger side.
 *
 * Listens to the same `message:new` the incoming worker publishes for every
 * persisted message (the intelligence-live subscriber uses it too), so no other
 * service changes. Only INBOUND, non-VOICE messages schedule anything; whether
 * the conversation is a person's, and whether the tenant has Copilot, is
 * decided when the debounce fires (copilot-suggestions.service.ts).
 */
import { subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { scheduleSuggestionsOnInbound } from "../../services/copilot-suggestions.service";

let _started = false;

export function handleMessageEvent(evt: ServiceEvent): boolean {
  if (evt.event !== "message:new") return false;
  const data = (evt.data ?? {}) as { conversationId?: string; channel?: string; message?: { direction?: string } };
  if (!evt.tenantId || !data.conversationId) return false;
  if (data.message?.direction !== "INBOUND") return false;
  if (String(data.channel ?? "") === "VOICE") return false;
  scheduleSuggestionsOnInbound(evt.tenantId, data.conversationId);
  return true;
}

export function startCopilotSuggestionsSubscriber(): void {
  if (_started) return;
  _started = true;
  if ((process.env.COPILOT_SUGGESTIONS_ON_INBOUND || "on").toLowerCase() === "off") {
    console.log("[copilot-suggestions] on-inbound generation disabled (COPILOT_SUGGESTIONS_ON_INBOUND=off)");
    return;
  }
  subscribeToEvents((evt: ServiceEvent) => {
    try { handleMessageEvent(evt); } catch (err: any) {
      console.warn("[copilot-suggestions] subscriber error:", err?.message ?? err);
    }
  });
  console.log("[copilot-suggestions] subscribed to message:new");
}
