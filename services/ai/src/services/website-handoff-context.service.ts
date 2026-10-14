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
  if (ev && !fromId) return pageContext((ev.metadata as any)?.page);
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

/**
 * Started from the website's WhatsApp widget (no website conversation): the
 * page they wrote from. The product handle is a lookup key, never a fact.
 */
function pageContext(page: unknown): string {
  const p = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
  const handle = typeof p.productHandle === "string" && p.productHandle ? p.productHandle : null;
  const path = typeof p.path === "string" && p.path ? p.path : null;
  const lines = ["This customer started this conversation from the business's website, through its WhatsApp button."];
  if (handle) lines.push(`They were looking at the product with handle "${handle}". Look it up before you mention its name, price or stock, and assume their first message is about it unless they say otherwise.`);
  else if (path) lines.push(`They wrote from the page ${path}.`);
  lines.push("Their first message here is what they wrote on the website. Answer it; do not greet them as if they had said nothing.");
  return lines.join("\n");
}
