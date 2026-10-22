import { prisma } from "@chatcenter/shared";
import { generateResponse } from "./ai.service";
import { getPolicyPrompt } from "./policy.service";
import { humanizeReply } from "./reply-style";

/**
 * F6.3 - Follow-up message generator.
 *
 * Given an idle conversation, produces a contextual follow-up reply the
 * idle-conversation worker can dispatch. Pulls last N messages + applies
 * business policy from F8. Returns null when there is nothing useful to
 * send (e.g. conversation was never inbound, or opt-out flagged).
 */
export async function generateFollowup(
  tenantId: string,
  conversationId: string,
  opts: { maxMessages?: number } = {},
): Promise<{ body: string; reason: string } | null> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
  });
  if (!convo) return null;

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: opts.maxMessages ?? 20,
  });
  if (messages.length === 0) return null;

  const lastInbound = messages.find((m) => m.direction === "INBOUND");
  if (!lastInbound) return null;

  const transcript = messages
    .slice()
    .reverse()
    .map((m) => `${m.direction === "INBOUND" ? "Customer" : "Agent"}: ${m.body ?? ""}`)
    .join("\n");

  const policyPrompt = await getPolicyPrompt(tenantId);

  const response = await generateResponse({
    tenantId,
    sessionId: conversationId,
    messages: [
      {
        role: "system",
        content:
          `You are a polite re-engagement writer. Produce a SHORT follow-up message ` +
          `(max 2 sentences) for a stale conversation. Respect the policy below.\n\n` +
          policyPrompt +
          `\n\nReturn STRICT JSON: { "body": string, "reason": string }.\n` +
          `If there is nothing useful to send, return { "body": "", "reason": "<why skip>" }.`,
      },
      {
        role: "user",
        content: `Conversation transcript (most recent last):\n${transcript}`,
      },
    ],
    temperature: 0.3,
    responseFormat: { type: "json_object" },
    metadata: { type: "followup", conversationId },
  });

  try {
    const parsed = JSON.parse(response.content) as { body?: string; reason?: string };
    // The same customer-facing style pass as every other AI reply (no wide
    // dashes, no spaced-hyphen clause joins). It used to send the model's text raw.
    const body = humanizeReply(parsed.body ?? null)?.trim();
    if (!body) return null;
    return { body, reason: parsed.reason ?? "re-engagement" };
  } catch {
    return null;
  }
}
