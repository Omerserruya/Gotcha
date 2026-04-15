import { prisma } from "@chatcenter/shared";
import { getPolicy, validateAgainstPolicy } from "./policy.service";
import { getCrmConnector, getMessagingConnector } from "./connectors/types";

/**
 * Internal HTTP helper — calls the conversation service over the service
 * mesh. CONVERSATION_SERVICE_URL is required in production; in tests it
 * defaults to a local value so mocks (undici MSW, or `global.fetch`
 * overrides) can intercept.
 *
 * Auth propagation: the caller's original `Authorization` header and
 * tenant id flow through so the downstream `authenticate + resolveTenant`
 * middleware chain accepts the request exactly as it would from the
 * front-end. If no auth token is available we fall back to an internal
 * service token (INTERNAL_SERVICE_TOKEN) for cron-initiated flows.
 */
async function callConversationService(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  ctx: { tenantId: string; authToken?: string },
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const base = process.env.CONVERSATION_SERVICE_URL ?? "http://conversation-service:3000";
  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = ctx.authToken ?? process.env.INTERNAL_SERVICE_TOKEN;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = ctx.tenantId;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const errBody =
        typeof data === "object" && data && "error" in (data as any)
          ? String((data as any).error)
          : `upstream ${res.status}`;
      return { ok: false, status: res.status, data, error: errBody };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? "fetch failed" };
  }
}

export type ActionTool =
  | "send_message"
  | "create_broadcast"
  | "update_crm"
  | "update_contact"
  | "create_ticket"
  | "create_task"
  | "schedule_followup"
  | "tag_contact"
  | "get_contact"
  | "get_conversation"
  | "list_recent_messages"
  | "preview_broadcast"
  | "schedule_broadcast"
  | "create_workflow"
  | "list_workflows"
  | "resolve_identity"
  | "merge_contacts"
  | "noop";

export interface PlannedAction {
  tool: ActionTool;
  params: Record<string, unknown>;
  reason: string;
  riskLevel: "low" | "medium" | "high";
}

export interface ExecutionResult {
  tool: ActionTool;
  ok: boolean;
  output?: unknown;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  auditFailed?: boolean;
}

const HIGH_RISK_TOOLS: ActionTool[] = [
  "send_message",
  "create_broadcast",
  "update_crm",
  "schedule_followup",
];

/**
 * F3.5 — Safe execution wrapper.
 * Blocks high-risk actions unless explicitly approved (F4 gate).
 */
export function validateAction(
  action: PlannedAction,
  opts: { approved?: boolean; approvedBy?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!action.tool) return { ok: false, reason: "missing tool" };
  if (action.riskLevel === "high" || HIGH_RISK_TOOLS.includes(action.tool)) {
    if (!opts.approved || !opts.approvedBy) {
      return { ok: false, reason: "high-risk action requires approval" };
    }
  }
  return { ok: true };
}

/**
 * F3.2 — Action executor. Dispatches a PlannedAction and writes an
 * immutable audit log (AuditLog). Service connectors (F3.3 CRM, F3.4
 * messaging) are stubbed — integrations service handles real dispatch.
 */
export interface ExecutorContext {
  actorId?: string;
  approved?: boolean;
  approvedBy?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  /**
   * Raw `Authorization` header from the originating request. Propagated
   * to downstream services so their `authenticate` middleware accepts
   * the call. Falls back to INTERNAL_SERVICE_TOKEN env if absent.
   */
  authToken?: string;
}

export async function executeAction(
  tenantId: string,
  action: PlannedAction,
  ctx: ExecutorContext,
): Promise<ExecutionResult> {
  const gate = validateAction(action, ctx);
  if (!("ok" in gate) || gate.ok !== true) {
    const reason = (gate as { ok: false; reason: string }).reason;
    await audit(tenantId, action, ctx, { blocked: true, reason });
    return { tool: action.tool, ok: false, skipped: true, skipReason: reason };
  }

  // F8 — policy enforcement gate (hard)
  const policy = await getPolicy(tenantId);
  const policyGate = validateAgainstPolicy(policy, { tool: action.tool, params: action.params });
  if (!("ok" in policyGate) || policyGate.ok !== true) {
    const reason = (policyGate as { ok: false; reason: string }).reason;
    await audit(tenantId, action, ctx, { blocked: true, policyViolation: reason });
    return { tool: action.tool, ok: false, skipped: true, skipReason: reason };
  }

  if (ctx.dryRun) {
    await audit(tenantId, action, ctx, { dryRun: true });
    return { tool: action.tool, ok: true, output: { dryRun: true } };
  }

  let output: unknown = null;
  try {
    switch (action.tool) {
      case "tag_contact": {
        const { contactId, tags } = action.params as { contactId: string; tags: string[] };
        // Tenant-scoped lookup — prevents cross-tenant mutation if an id leaks.
        const existing = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
        if (!existing) throw new Error("contact not found");
        const merged = Array.from(
          new Set([...(existing.tags as string[] | null ?? []), ...(tags ?? [])]),
        );
        output = await prisma.contact.update({
          where: { id: contactId },
          data: { tags: merged as any },
          select: { id: true, tags: true },
        });
        break;
      }
      case "noop":
        output = { note: (action.params as { note?: string } | undefined)?.note ?? action.reason };
        break;
      case "send_message": {
        const conn = getMessagingConnector();
        if (!conn) throw new Error("no messaging connector registered");
        const { contactId, channel, body } = action.params as {
          contactId: string;
          channel: "whatsapp" | "email" | "sms" | "webchat";
          body: string;
        };
        output = await conn.send(tenantId, { contactId, channel, body });
        break;
      }
      case "update_crm": {
        const conn = getCrmConnector();
        if (!conn) throw new Error("no CRM connector registered");
        const { contactId, fields } = action.params as {
          contactId: string;
          fields: Record<string, unknown>;
        };
        output = await conn.updateContact(tenantId, { contactId, fields });
        break;
      }
      case "create_ticket": {
        const conn = getCrmConnector();
        if (!conn) throw new Error("no CRM connector registered");
        const { contactId, subject, body, priority } = action.params as {
          contactId: string;
          subject: string;
          body: string;
          priority?: "low" | "normal" | "high" | "urgent";
        };
        output = await conn.createTicket(tenantId, { contactId, subject, body, priority });
        break;
      }
      case "get_contact": {
        const { contactId } = action.params as { contactId: string };
        output = await prisma.contact.findFirst({
          where: { id: contactId, tenantId },
        });
        if (!output) throw new Error("contact not found");
        break;
      }
      case "get_conversation": {
        const { conversationId } = action.params as { conversationId: string };
        output = await prisma.conversation.findFirst({
          where: { id: conversationId, tenantId },
        });
        if (!output) throw new Error("conversation not found");
        break;
      }
      case "list_recent_messages": {
        const { conversationId, limit } = action.params as { conversationId: string; limit?: number };
        output = await prisma.message.findMany({
          where: { conversationId, tenantId },
          orderBy: { createdAt: "desc" },
          take: Math.min(typeof limit === "number" ? limit : 20, 50),
        });
        break;
      }
      case "update_contact": {
        const conn = getCrmConnector();
        if (!conn) throw new Error("no CRM connector registered");
        const { contactId, fields } = action.params as { contactId: string; fields: Record<string, unknown> };
        output = await conn.updateContact(tenantId, { contactId, fields });
        break;
      }
      case "create_task": {
        const conn = getCrmConnector();
        if (!conn) throw new Error("no CRM connector registered");
        const { contactId, subject, body, priority } = action.params as {
          contactId: string; subject: string; body: string;
          priority?: "low" | "normal" | "high" | "urgent";
        };
        output = await conn.createTicket(tenantId, { contactId, subject, body, priority });
        break;
      }
      case "create_workflow": {
        const p = action.params as {
          name?: string;
          description?: string;
          triggers?: unknown;
          steps?: unknown;
          nodes?: unknown;
          edges?: unknown;
          channel?: string;
          greeting?: string;
          message?: string;
        };
        const name = (p.name && String(p.name).trim()) || "New AI workflow";
        // If LLM returned a proper React-Flow graph, honor it.
        // Otherwise synthesize a minimal valid starter: start → message → end.
        // This guarantees the flow editor opens on a real graph the user can edit,
        // instead of an empty canvas.
        const hasRealGraph =
          Array.isArray(p.nodes) && (p.nodes as unknown[]).length > 0 &&
          (p.nodes as any[]).every((n) => n && typeof n.id === "string" && typeof n.type === "string" && n.position);

        let seedNodes: unknown[];
        let seedEdges: unknown[];
        if (hasRealGraph) {
          seedNodes = p.nodes as unknown[];
          seedEdges = Array.isArray(p.edges) ? (p.edges as unknown[]) : [];
        } else {
          // Derive a greeting message from whatever text the LLM gave us.
          const greetingText =
            (typeof p.greeting === "string" && p.greeting.trim()) ||
            (typeof p.message === "string" && p.message.trim()) ||
            (Array.isArray(p.steps) && p.steps.length > 0
              ? (() => {
                  const first = p.steps[0] as any;
                  return (
                    (typeof first?.text === "string" && first.text) ||
                    (typeof first?.message === "string" && first.message) ||
                    (typeof first?.body === "string" && first.body) ||
                    (typeof first === "string" ? first : "") ||
                    "Hello! How can I help you?"
                  );
                })()
              : "Hello! How can I help you?");
          seedNodes = [
            { id: "start-1", type: "start", position: { x: 250, y: 50 }, data: {} },
            { id: "msg-1", type: "message", position: { x: 250, y: 200 }, data: { text: greetingText } },
            { id: "end-1", type: "end", position: { x: 250, y: 360 }, data: {} },
          ];
          seedEdges = [
            { id: "e-start-msg", source: "start-1", target: "msg-1" },
            { id: "e-msg-end", source: "msg-1", target: "end-1" },
          ];
        }

        output = await prisma.chatbotFlow.create({
          data: {
            tenantId,
            name,
            description: p.description ?? (typeof p.triggers === "string" ? p.triggers : null),
            isActive: false,
            nodes: seedNodes as any,
            edges: seedEdges as any,
          },
          select: { id: true, name: true, isActive: true, createdAt: true },
        });
        break;
      }
      case "list_workflows": {
        output = await prisma.chatbotFlow.findMany({
          where: { tenantId },
          select: { id: true, name: true, isActive: true, channel: true, runCount: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 50,
        });
        break;
      }
      case "create_broadcast": {
        // POST /api/broadcasts — requires name, channel, channelAccountId.
        // The planner passes whatever it produced; missing fields return
        // a loud 400 from the downstream route and propagate here.
        const r = await callConversationService("POST", "/api/broadcasts", action.params, {
          tenantId,
          authToken: ctx.authToken,
        });
        if (!r.ok) throw new Error(`create_broadcast upstream: ${r.error}`);
        output = r.data;
        break;
      }
      case "schedule_broadcast": {
        // Existing broadcasts route supports PATCH with { scheduledAt }
        // on DRAFT/SCHEDULED rows — that is the real "schedule" op.
        const { broadcastId, scheduleAt } = action.params as {
          broadcastId: string;
          scheduleAt: string;
        };
        if (!broadcastId || !scheduleAt) {
          throw new Error("schedule_broadcast requires broadcastId and scheduleAt");
        }
        const r = await callConversationService(
          "PATCH",
          `/api/broadcasts/${encodeURIComponent(broadcastId)}`,
          { scheduledAt: scheduleAt },
          { tenantId, authToken: ctx.authToken },
        );
        if (!r.ok) throw new Error(`schedule_broadcast upstream: ${r.error}`);
        output = r.data;
        break;
      }
      case "preview_broadcast": {
        // Read-only validation path. No /preview route exists upstream;
        // /validate on a DRAFT broadcast is the closest real primitive.
        const { broadcastId } = action.params as { broadcastId?: string };
        if (!broadcastId) {
          throw new Error(
            "preview_broadcast requires broadcastId (create the broadcast first, then preview)",
          );
        }
        const r = await callConversationService(
          "POST",
          `/api/broadcasts/${encodeURIComponent(broadcastId)}/validate`,
          {},
          { tenantId, authToken: ctx.authToken },
        );
        if (!r.ok) throw new Error(`preview_broadcast upstream: ${r.error}`);
        output = r.data;
        break;
      }
      case "resolve_identity": {
        const r = await callConversationService("POST", "/api/identity/resolve", action.params, {
          tenantId,
          authToken: ctx.authToken,
        });
        if (!r.ok) throw new Error(`resolve_identity upstream: ${r.error}`);
        output = r.data;
        break;
      }
      case "merge_contacts": {
        const r = await callConversationService("POST", "/api/identity/merge", action.params, {
          tenantId,
          authToken: ctx.authToken,
        });
        if (!r.ok) throw new Error(`merge_contacts upstream: ${r.error}`);
        output = r.data;
        break;
      }
      case "schedule_followup": {
        // Direct DB insert of a ScheduledMessage row — the same model
        // scheduled.worker.ts polls every 30s. This IS the real path:
        // the worker picks up PENDING rows whose scheduledAt has elapsed
        // and enqueues them into outgoingMessageQueue.
        const p = action.params as {
          contactId: string;
          body: string;
          scheduleAt: string;
          channel?: string;
          channelAccountId?: string;
        };
        if (!p.contactId || !p.body || !p.scheduleAt) {
          throw new Error("schedule_followup requires contactId, body, scheduleAt");
        }
        const contact = await prisma.contact.findFirst({
          where: { id: p.contactId, tenantId },
          select: { externalId: true, channel: true },
        });
        if (!contact) throw new Error("contact not found");
        const channel = (p.channel ?? contact.channel) as any;
        let channelAccountId = p.channelAccountId;
        if (!channelAccountId) {
          const acct = await prisma.channelAccount.findFirst({
            where: { tenantId, channel, isActive: true },
            select: { id: true },
          });
          if (!acct) {
            throw new Error(
              `no active channelAccount for channel ${channel} — pass channelAccountId explicitly`,
            );
          }
          channelAccountId = acct.id;
        }
        const scheduledAt = new Date(p.scheduleAt);
        if (Number.isNaN(scheduledAt.getTime())) {
          throw new Error("schedule_followup: scheduleAt must be a valid ISO datetime");
        }
        output = await prisma.scheduledMessage.create({
          data: {
            tenantId,
            channel,
            channelAccountId,
            recipientExternalId: contact.externalId,
            body: p.body,
            scheduledAt,
            status: "PENDING" as any,
            createdBy: ctx.actorId ?? "ai",
          },
          select: { id: true, scheduledAt: true, status: true },
        });
        break;
      }
      default:
        throw new Error(`unsupported tool: ${action.tool}`);
    }
  } catch (err: any) {
    await audit(tenantId, action, ctx, { error: err?.message });
    return { tool: action.tool, ok: false, error: err?.message };
  }

  // Propagate connector-level failures (non-throwing {ok:false}).
  const connOk = (output as any)?.ok;
  if (connOk === false) {
    const connError = (output as any)?.error ?? "connector reported failure";
    const auditOk = await audit(tenantId, action, ctx, { output, connectorError: connError });
    return { tool: action.tool, ok: false, output, error: connError, auditFailed: !auditOk };
  }

  const auditOk = await audit(tenantId, action, ctx, { output });
  return { tool: action.tool, ok: true, output, auditFailed: !auditOk };
}

async function audit(
  tenantId: string,
  action: PlannedAction,
  ctx: ExecutorContext,
  result: Record<string, unknown>,
): Promise<boolean> {
  try {
    const contactId =
      typeof (action.params as any)?.contactId === "string"
        ? ((action.params as any).contactId as string)
        : null;
    await prisma.auditLog.create({
      data: {
        tenantId,
        actorType: "ai",
        actorId: ctx.actorId ?? null,
        action: `action.${action.tool}`,
        targetType: contactId ? "contact" : "action",
        targetId: contactId,
        metadata: {
          reason: action.reason,
          riskLevel: action.riskLevel,
          params: action.params,
          approved: ctx.approved === true,
          approvedBy: ctx.approvedBy ?? null,
          dryRun: ctx.dryRun === true,
          idempotencyKey: ctx.idempotencyKey ?? null,
          ...result,
        } as any,
      },
    });
    return true;
  } catch (err) {
    console.error("action-executor audit failed:", err);
    return false;
  }
}
