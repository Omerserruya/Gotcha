/**
 * System Copilot - UI context injector.
 *
 * Builds the per-turn context block the agent runtime prepends to its
 * messages. The Command Center frontend submits whatever it knows about
 * the operator's current view (route, selected conversation, selected
 * contact); this service normalises it, optionally enriches it with a
 * lightweight fetch (selected entity name + status), and returns a
 * markdown block ready to drop into a system message.
 *
 * Goals:
 *  - Make every turn aware of *what the operator is looking at* without
 *    requiring them to restate IDs.
 *  - Keep the block small (~< 500 tokens). Just enough to disambiguate.
 *  - Fail open: a context-fetch error must never break the agent loop.
 */

import { prisma } from "@chatcenter/shared";

export interface ClientContext {
  /** Path the operator was on when they opened the palette (e.g. "/conversations"). */
  route?: string | null;
  /** Conversation row currently selected, if the route is conversation-scoped. */
  conversationId?: string | null;
  /** Contact row currently selected (Customers page or detail drawer). */
  contactId?: string | null;
  /** Free-form extra signals from the UI (selected workflow, draft broadcast, etc.). */
  extras?: Record<string, unknown> | null;
}

export interface OperatorContext {
  tenantId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  tenantName?: string;
}

export interface BuiltAgentContext {
  block: string;
  resolved: {
    conversationId: string | null;
    contactId: string | null;
    route: string | null;
  };
}

const MAX_RECENT_LINES = 5;

/**
 * Compose the context system message. Returns the markdown block plus the
 * resolved IDs the runtime can pass to the tool surface (so a tool like
 * `system_summarize_conversation` doesn't need an explicit id arg when
 * one is already in context).
 */
export async function buildAgentContext(opts: {
  operator: OperatorContext;
  client?: ClientContext | null;
}): Promise<BuiltAgentContext> {
  const op = opts.operator;
  const client = opts.client ?? {};
  const lines: string[] = ["## Operator & UI Context"];

  // Operator identity. The system prompt says "the person talking to you is
  // an operator" - naming them helps the model's tone.
  lines.push(`- Operator: ${op.userName || op.userEmail || op.userId}`);
  if (op.userRole) lines.push(`- Role: ${op.userRole}`);
  if (op.tenantName) lines.push(`- Workspace: ${op.tenantName}`);
  if (client.route) lines.push(`- Current route: \`${client.route}\``);

  // Resolve selected entities. Best-effort - any failure here is logged and
  // the line is omitted rather than throwing.
  let resolvedConversationId: string | null = null;
  let resolvedContactId: string | null = null;

  if (client.conversationId) {
    try {
      const c = await prisma.conversation.findFirst({
        where: { id: client.conversationId, tenantId: op.tenantId },
        select: {
          id: true,
          channel: true,
          status: true,
          customerName: true,
          customerExternalId: true,
          lastMessageAt: true,
          assignedAgentId: true,
        },
      });
      if (c) {
        resolvedConversationId = c.id;
        const who = c.customerName || c.customerExternalId;
        const last = c.lastMessageAt ? c.lastMessageAt.toISOString() : "-";
        lines.push(
          `- Selected conversation: \`${c.id}\` - ${who} (${c.channel.toLowerCase()}, ${c.status}, last activity ${last})`,
        );
      }
    } catch (err: any) {
      console.warn("[agent-context] conversation lookup failed:", err?.message);
    }
  }

  if (client.contactId) {
    try {
      const ct = await prisma.contact.findFirst({
        where: { id: client.contactId, tenantId: op.tenantId },
        select: { id: true, displayName: true, channel: true, externalId: true, email: true, phone: true },
      });
      if (ct) {
        resolvedContactId = ct.id;
        lines.push(
          `- Selected contact: \`${ct.id}\` - ${ct.displayName || ct.email || ct.phone || ct.externalId}`,
        );
      }
    } catch (err: any) {
      console.warn("[agent-context] contact lookup failed:", err?.message);
    }
  }

  // Recent activity - keeps the model grounded ("today the operator was
  // looking at conversation X, then Y…"). Cheap query with the existing
  // index on Message(tenantId, createdAt).
  try {
    const recent = await prisma.message.findMany({
      where: { tenantId: op.tenantId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_LINES,
      select: {
        conversationId: true,
        body: true,
        createdAt: true,
        conversation: {
          select: { customerName: true, customerExternalId: true, channel: true },
        },
      },
    });
    if (recent.length > 0) {
      lines.push("- Recent inbound activity:");
      for (const m of recent) {
        const who =
          (m as any).conversation?.customerName ||
          (m as any).conversation?.customerExternalId ||
          "unknown";
        const snippet = (m.body || "").trim().slice(0, 80);
        lines.push(`  - ${m.createdAt.toISOString()} · ${who} · "${snippet}"`);
      }
    }
  } catch (err: any) {
    console.warn("[agent-context] recent activity lookup failed:", err?.message);
  }

  if (client.extras && typeof client.extras === "object") {
    const entries = Object.entries(client.extras).slice(0, 8);
    if (entries.length > 0) {
      lines.push("- UI extras:");
      for (const [k, v] of entries) {
        lines.push(`  - ${k}: ${typeof v === "string" ? v : JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }

  return {
    block: lines.join("\n"),
    resolved: {
      conversationId: resolvedConversationId,
      contactId: resolvedContactId,
      route: client.route ?? null,
    },
  };
}
