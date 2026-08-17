/**
 * Who is driving a conversation right now.
 *
 * The inbox list and the chat panel both have to answer this, and they must
 * answer it identically: the list uses it to decide which section a row lives
 * in, the panel uses it to decide whether the co-pilot may open. If the two
 * ever disagree, a conversation files itself under "the AI is handling this"
 * and then greets the agent with a co-pilot demanding they reply to it.
 *
 * Mirrors `automatedOnly` in services/conversation/src/services/conversation.service.ts.
 * Changing one without the other splits the definition again.
 */

/** `Conversation.handledBy` values that mean an automation owns the thread. */
const AUTOMATED_HANDLERS = new Set(["ai_agent", "flow"]);

export interface OwnershipFields {
  handledBy?: string | null;
  isHandedOver?: boolean | null;
  assignedAgentId?: string | null;
}

/**
 * True when an automation owns this conversation and no human has taken it.
 *
 * All three conditions are load-bearing. `handledBy` names the driver,
 * `isHandedOver` is the latch a takeover sets, and `assignedAgentId` catches a
 * claim that never flipped the latch. Any one of them alone lets a
 * human-owned conversation read as AI-owned.
 */
export function isAiManaged(conv: OwnershipFields | null | undefined): boolean {
  if (!conv) return false;
  return (
    AUTOMATED_HANDLERS.has(conv.handledBy ?? "") &&
    !conv.isHandedOver &&
    !conv.assignedAgentId
  );
}

/** "ai_agent" → an AI employee; "flow" → an authored chatbot flow. */
export function isFlowManaged(conv: OwnershipFields | null | undefined): boolean {
  return isAiManaged(conv) && conv?.handledBy === "flow";
}
