import { prisma } from "@chatcenter/shared";
import { getPolicy, validateAgainstPolicy } from "./policy.service";
import { getCrmConnector, getMessagingConnector } from "./connectors/types";

export type ActionTool =
  | "send_message"
  | "create_broadcast"
  | "update_crm"
  | "create_ticket"
  | "schedule_followup"
  | "tag_contact"
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
      case "create_broadcast":
      case "schedule_followup":
        // still delegated to domain services (broadcasts/scheduled-messages routes)
        output = { queued: true, note: "delegated to domain service" };
        break;
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
