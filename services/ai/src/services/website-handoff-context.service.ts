/**
 * When a WhatsApp conversation continues a website chat ("Continue on
 * WhatsApp"; the incoming worker records a `continued_from_website` system
 * event), the bot reads that website chat as context, so the customer is not
 * asked to repeat what they already said there.
 */
import { prisma } from "@chatcenter/shared";

const MAX_LINES = 30;
const MAX_CHARS = 300;

export async function websiteHandoffContext(
  tenantId: string,
  messages: Array<{ messageType?: string | null; metadata?: unknown }>,
): Promise<string | null> {
  const ev = messages.find((m) => m.messageType === "system" && (m.metadata as any)?.systemEvent === "continued_from_website");
  const fromId = (ev?.metadata as any)?.fromConversationId;
  if (typeof fromId !== "string" || !fromId) return null;
  const rows = await prisma.message.findMany({
    where: { tenantId, conversationId: fromId, messageType: { not: "system" } },
    orderBy: { createdAt: "desc" },
    take: MAX_LINES,
    select: { direction: true, body: true },
  });
  const lines = rows
    .reverse()
    .filter((m) => (m.body ?? "").trim())
    .map((m) => `${m.direction === "INBOUND" ? "Customer" : "Business"}: ${(m.body ?? "").trim().slice(0, MAX_CHARS)}`);
  if (!lines.length) return null;
  return [
    "This customer is continuing here a conversation they started in the website chat. That conversation, oldest first:",
    ...lines,
    "Pick up where it left off. Do not ask for anything they already told you there, and do not greet them as a new customer.",
  ].join("\n");
}
