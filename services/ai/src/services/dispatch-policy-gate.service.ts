/**
 * The last thing that runs before a provider does something real.
 *
 * Every other policy check in this codebase answers a question about what the
 * assistant should be OFFERED. This one answers what may actually EXECUTE, and
 * it is the only check positioned where that distinction cannot be skipped.
 *
 * The gap it closes was found live. An operator had disabled `process_refund`.
 * The bot surface refused it correctly - `ai-bot.service.ts` builds its adapter
 * guest list from `AgentToolPermission.isAllowed AND TenantTool.isEnabled AND
 * CONNECTED`, so the model was never offered the tool and could not propose it.
 * But calling `executeAdapterTool` directly with that same tool did not refuse.
 * It went to Shopify, which declined only because that particular order had
 * nothing left to refund:
 *
 *     {"ok":false,"reason":"refund_exceeds_refundable: requested 0.01 USD
 *                           but only 0.00 USD is refundable"}
 *
 * On an order with a balance, the operator's decision would have been worth
 * nothing. The provider, not the product, was deciding.
 *
 * That matters most on the approved-HITL path. `runApprovedAction` revalidates
 * business policy rules and fails closed, but it never re-read
 * `TenantTool.isEnabled` - so an approval raised while a tool was enabled could
 * still execute after an operator switched it off. The human said yes to a
 * question the tenant had since answered no to.
 *
 * ── What this gate does NOT do ───────────────────────────────────────────────
 *
 * It is not a second policy engine. `executeAdapterTool` already resolves the
 * connection, refreshes credentials, checks granted scopes and short-circuits
 * on known-missing capability. Re-implementing those here would give us two
 * answers to the same question and a bug the day they disagreed. This gate adds
 * only the four checks nothing owned:
 *
 *   1. tenant tool policy      - is this tool enabled for this tenant at all
 *   2. actor mode              - may THIS kind of caller run it
 *   3. HITL + approval         - if a human must say yes, did the right human
 *                                say yes to THIS tool with THESE arguments
 *   4. idempotency             - has this exact operation already run
 *
 * and returns a structured decision the caller maps to a customer-safe outcome.
 *
 * ── Why the actor is a parameter and not an inference ────────────────────────
 *
 * "Internal" was never one thing. It covered the approval dispatcher, the CRM
 * writeback, the copilot behind an authenticated membership, and background
 * jobs - four callers with four different rights, all indistinguishable at the
 * boundary. Collapsing them meant the only safe rule was the most permissive
 * one, which is how a disabled tool stayed executable.
 *
 * The actor comes from the CALLER's code path. It is never read from tool
 * arguments, never inferred from the model's output, and never taken from a
 * request body - an AI-supplied "actor" would be an AI granting itself rights.
 */

import { prisma } from "@chatcenter/shared";

/** Who is asking. Set by the calling code path, never by a model or a client. */
export type DispatchActor =
  /** The autonomous bot acting for a customer channel. Most constrained. */
  | { type: "customer_ai"; conversationId?: string }
  /** A human's assistant. May propose; may not self-approve. */
  | { type: "copilot"; userId: string; conversationId?: string }
  /** A person in the tenant, acting under RBAC. */
  | { type: "human_agent"; userId: string; permissions?: string[] }
  /** A tenant admin. Does NOT implicitly bypass a disabled tool. */
  | { type: "admin"; userId: string; override?: AdminOverride }
  /** Server-side machinery. Requires a declared purpose. */
  | { type: "internal_service"; purpose: string };

/**
 * An admin turning a tool back on for one call. Deliberately verbose: an
 * override that is easy to write is an override that gets written by accident.
 */
export interface AdminOverride {
  reason: string;
  grantedBy: string;
}

export type DispatchDenial =
  | "DENY_TOOL_DISABLED"
  | "DENY_MODE"
  | "DENY_DISCONNECTED"
  | "DENY_MISSING_SCOPE"
  | "DENY_PROVIDER_UNAVAILABLE"
  | "DENY_APPROVAL_REQUIRED"
  | "DENY_APPROVAL_REJECTED"
  | "DENY_APPROVAL_MISMATCH"
  | "DENY_APPROVAL_STALE"
  | "DENY_ALREADY_EXECUTED"
  | "DENY_TENANT_MISMATCH"
  | "DENY_UNAUTHENTICATED_SERVICE";

export type DispatchDecision =
  | { decision: "ALLOW"; approvalId?: string; overrodePolicy?: boolean }
  | { decision: DispatchDenial; reason: string; approvalId?: string };

export interface DispatchGateInput {
  tenantId: string;
  /** Dotted provider tool name, e.g. `shopify.process_refund`. */
  toolFunctionName: string;
  args: Record<string, unknown>;
  actor: DispatchActor;
  conversationId?: string;
  /**
   * Set by the approval dispatcher. The gate re-verifies it rather than
   * trusting that the caller checked - the caller having checked is exactly
   * what was assumed, and wrong, before this existed.
   */
  approvalId?: string;
  /**
   * Stable key for "this same operation". When present, a prior SUCCEEDED
   * approval carrying it means the work is already done.
   */
  operationKey?: string;
}

/** Actors that may never execute a tool the tenant has switched off. */
const POLICY_BOUND_ACTORS = new Set(["customer_ai", "copilot", "human_agent", "admin"]);

/** Actors whose turn is a customer-facing conversation subject to HITL. */
const HITL_BOUND_ACTORS = new Set(["customer_ai", "copilot"]);

interface HitlPolicy {
  mode?: "always" | "never" | string;
  approverRole?: string;
  expiresAfterMin?: number;
  allowModification?: boolean;
}

function hitlPolicyOf(configOverrides: unknown): HitlPolicy | null {
  if (!configOverrides || typeof configOverrides !== "object") return null;
  const p = (configOverrides as Record<string, unknown>).hitlPolicy;
  if (!p || typeof p !== "object") return null;
  return p as HitlPolicy;
}

/**
 * Normalise arguments for comparison against what a human approved.
 *
 * Key order, whitespace and null-vs-absent are not decisions anybody made, so
 * differing on them would reject valid approvals. Values are compared exactly:
 * an approval for a 40 refund is not an approval for a 400 one, and that is the
 * whole point of comparing at all.
 */
export function normaliseArgs(args: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (o[k] === undefined) continue;
        out[k] = walk(o[k]);
      }
      return out;
    }
    if (typeof v === "string") return v.trim();
    return v;
  };
  return JSON.stringify(walk(args));
}

/**
 * The canonical final execution gate.
 *
 * Fails closed on its own errors for policy-bound actors: if we cannot prove a
 * tool is allowed, it is not allowed. Internal services with a declared purpose
 * are allowed through a gate fault, because the alternative is that a database
 * hiccup silently stops CRM writeback and identity linking, which are not the
 * risk this gate exists to manage.
 */
export async function assertDispatchAllowed(input: DispatchGateInput): Promise<DispatchDecision> {
  const { tenantId, toolFunctionName, actor } = input;
  const dot = toolFunctionName.indexOf(".");
  const toolSlug = dot < 0 ? toolFunctionName : toolFunctionName.slice(dot + 1);
  const providerSlug = dot < 0 ? "" : toolFunctionName.slice(0, dot);

  if (!tenantId) {
    return { decision: "DENY_TENANT_MISMATCH", reason: "no tenant in trusted server context" };
  }

  // An internal service must say who it is and why. An empty purpose is an
  // unauthenticated service call wearing the internal label.
  if (actor.type === "internal_service" && !String(actor.purpose ?? "").trim()) {
    return {
      decision: "DENY_UNAUTHENTICATED_SERVICE",
      reason: "internal_service actor must declare a purpose",
    };
  }

  try {
    // ── 1. Tenant tool policy ────────────────────────────────────────────────
    const tenantTool = await prisma.tenantTool.findFirst({
      where: { tenantId, catalogTool: { slug: toolSlug } },
      select: {
        id: true,
        isEnabled: true,
        configOverrides: true,
        catalogTool: { select: { slug: true, allowedModes: true, category: true } },
        tenantIntegration: { select: { status: true, integration: { select: { slug: true } } } },
      },
    });

    if (!tenantTool) {
      // No row means this tenant has no policy for this tool. For anything
      // customer-facing that is a refusal: absence of a decision is not consent.
      // Internal machinery legitimately calls provider tools that were never
      // catalogued (CRM adapters reach `fireberry.get_record` and friends), so
      // a declared-purpose service call is allowed through.
      if (POLICY_BOUND_ACTORS.has(actor.type)) {
        return {
          decision: "DENY_TOOL_DISABLED",
          reason: `no tenant policy exists for ${toolFunctionName}`,
        };
      }
      return { decision: "ALLOW" };
    }

    // Cross-tenant safety. The query is already tenant-scoped, so reaching this
    // means something upstream handed us a mismatched pair.
    const connSlug = tenantTool.tenantIntegration?.integration?.slug;
    if (providerSlug && connSlug && connSlug !== providerSlug) {
      return {
        decision: "DENY_TENANT_MISMATCH",
        reason: `tool ${toolFunctionName} resolved to integration ${connSlug}`,
      };
    }

    // ── 2. Enabled state ─────────────────────────────────────────────────────
    if (!tenantTool.isEnabled) {
      // An admin may override, but only explicitly and only with an attributed
      // reason. Being an admin is not itself an override - that is how "admin
      // bypass" quietly becomes "policy is advisory".
      if (actor.type === "admin" && actor.override?.reason && actor.override?.grantedBy) {
        await recordGateAudit({
          tenantId, toolFunctionName, actor, decision: "ALLOW",
          note: `admin override: ${actor.override.reason}`,
        });
        return { decision: "ALLOW", overrodePolicy: true };
      }
      if (POLICY_BOUND_ACTORS.has(actor.type)) {
        return {
          decision: "DENY_TOOL_DISABLED",
          reason: `${toolFunctionName} is switched off for this tenant`,
        };
      }
      // Internal machinery must not run a tool the tenant disabled either. The
      // approval dispatcher is an internal service, and letting it through here
      // is precisely the hole this gate closes.
      return {
        decision: "DENY_TOOL_DISABLED",
        reason: `${toolFunctionName} is switched off for this tenant`,
      };
    }

    // ── 3. Actor mode ────────────────────────────────────────────────────────
    const modes = tenantTool.catalogTool?.allowedModes;
    if (Array.isArray(modes) && modes.length > 0) {
      const needed = actor.type === "customer_ai" ? "AUTO" : actor.type === "copilot" ? "ASSIST" : null;
      if (needed && !modes.includes(needed)) {
        return {
          decision: "DENY_MODE",
          reason: `${toolFunctionName} is not permitted in ${needed} mode`,
        };
      }
    }

    // ── 4. Connection ────────────────────────────────────────────────────────
    // Policy and availability are separate questions; this one is availability,
    // and it is checked here as well as upstream because an approval dispatched
    // minutes after a disconnect must not reach the provider.
    if (tenantTool.tenantIntegration && tenantTool.tenantIntegration.status !== "CONNECTED") {
      return {
        decision: "DENY_DISCONNECTED",
        reason: `${connSlug ?? providerSlug} is ${tenantTool.tenantIntegration.status}`,
      };
    }

    // ── 5. HITL and approval ─────────────────────────────────────────────────
    const hitl = hitlPolicyOf(tenantTool.configOverrides);
    const needsApproval = hitl?.mode === "always";

    if (needsApproval && HITL_BOUND_ACTORS.has(actor.type)) {
      if (!input.approvalId) {
        return {
          decision: "DENY_APPROVAL_REQUIRED",
          reason: `${toolFunctionName} requires human approval`,
        };
      }
      const verdict = await verifyApproval({
        tenantId,
        approvalId: input.approvalId,
        toolFunctionName,
        toolSlug,
        args: input.args,
        conversationId: input.conversationId,
        allowModification: hitl?.allowModification === true,
      });
      if (verdict.decision !== "ALLOW") return verdict;
    }

    // ── 6. Idempotency ───────────────────────────────────────────────────────
    if (input.operationKey) {
      const already = await prisma.approvalRequest.findFirst({
        where: {
          tenantId,
          operationKey: input.operationKey,
          executionState: { in: ["EXECUTING", "SUCCEEDED", "LEGACY_UNVERIFIED"] },
        },
        select: { id: true, executionState: true },
      });
      if (already) {
        return {
          decision: "DENY_ALREADY_EXECUTED",
          reason: `operation already ${already.executionState.toLowerCase()}`,
          approvalId: already.id,
        };
      }
    }

    return { decision: "ALLOW", approvalId: input.approvalId };
  } catch (err: any) {
    // Fail closed for anyone customer-facing. A gate that cannot answer must
    // not be read as a yes.
    if (POLICY_BOUND_ACTORS.has(actor.type)) {
      return {
        decision: "DENY_PROVIDER_UNAVAILABLE",
        reason: `policy gate unavailable: ${String(err?.message ?? "unknown").slice(0, 120)}`,
      };
    }
    return { decision: "ALLOW" };
  }
}

/**
 * Is this approval a real yes, to this tool, with these arguments, here, now,
 * and not already spent?
 *
 * Each of these has been a real incident somewhere in this codebase's history,
 * which is why none of them is assumed.
 */
async function verifyApproval(opts: {
  tenantId: string;
  approvalId: string;
  toolFunctionName: string;
  toolSlug: string;
  args: Record<string, unknown>;
  conversationId?: string;
  allowModification: boolean;
}): Promise<DispatchDecision> {
  const appr = await prisma.approvalRequest.findUnique({
    where: { id: opts.approvalId },
    select: {
      id: true, tenantId: true, conversationId: true, tool: true, params: true,
      status: true, executionState: true, expiresAt: true,
    },
  });

  if (!appr) {
    return { decision: "DENY_APPROVAL_MISMATCH", reason: "approval not found" };
  }
  // A fabricated or borrowed approval id from another tenant is the cheapest
  // possible attack, so it is the first thing checked.
  if (appr.tenantId !== opts.tenantId) {
    return { decision: "DENY_TENANT_MISMATCH", reason: "approval belongs to another tenant", approvalId: appr.id };
  }
  if (opts.conversationId && appr.conversationId && appr.conversationId !== opts.conversationId) {
    return {
      decision: "DENY_APPROVAL_MISMATCH",
      reason: "approval belongs to another conversation",
      approvalId: appr.id,
    };
  }

  // The approved tool must be THIS tool. Approvals store either the dotted name
  // or the bare slug depending on which path raised them, so both are accepted
  // - but nothing else is.
  const approvedTool = String(appr.tool ?? "");
  if (approvedTool !== opts.toolFunctionName && approvedTool !== opts.toolSlug) {
    return {
      decision: "DENY_APPROVAL_MISMATCH",
      reason: `approval is for ${approvedTool}, not ${opts.toolFunctionName}`,
      approvalId: appr.id,
    };
  }

  if (appr.status === "REJECTED" || appr.status === "CANCELLED") {
    return { decision: "DENY_APPROVAL_REJECTED", reason: `approval was ${appr.status.toLowerCase()}`, approvalId: appr.id };
  }
  if (appr.status === "EXPIRED") {
    return { decision: "DENY_APPROVAL_STALE", reason: "approval expired", approvalId: appr.id };
  }
  if (appr.status !== "APPROVED") {
    return { decision: "DENY_APPROVAL_REQUIRED", reason: `approval is ${appr.status.toLowerCase()}`, approvalId: appr.id };
  }
  // A row can be APPROVED and past its expiry if the sweeper has not run. The
  // timestamp is the truth, not the status field's last write.
  if (appr.expiresAt && appr.expiresAt.getTime() < Date.now()) {
    return { decision: "DENY_APPROVAL_STALE", reason: "approval expired", approvalId: appr.id };
  }

  // Spent once. `EXECUTING` counts: a duplicate callback arriving mid-flight is
  // the common way a refund happens twice.
  if (appr.executionState === "SUCCEEDED" || appr.executionState === "EXECUTING" ||
      appr.executionState === "LEGACY_UNVERIFIED") {
    return {
      decision: "DENY_ALREADY_EXECUTED",
      reason: `approval already ${appr.executionState.toLowerCase()}`,
      approvalId: appr.id,
    };
  }

  // What the human saw is what runs. Unless the tool's policy explicitly allows
  // an approver to edit the arguments, a changed amount or a changed order is a
  // different action wearing an old yes.
  if (!opts.allowModification) {
    const approved = normaliseArgs(appr.params ?? {});
    const actual = normaliseArgs(opts.args ?? {});
    if (approved !== actual) {
      return {
        decision: "DENY_APPROVAL_MISMATCH",
        reason: "arguments differ from what was approved",
        approvalId: appr.id,
      };
    }
  }

  return { decision: "ALLOW", approvalId: appr.id };
}

/**
 * Structured telemetry for a gate decision.
 *
 * Deliberately records the denial CLASS and never the arguments: a denied
 * refund's payload is the customer's order and money, and a security log is not
 * a place to copy it to. Never throws - a gate that fails because its own audit
 * failed would be a gate that fails open.
 */
export async function recordGateAudit(opts: {
  tenantId: string;
  toolFunctionName: string;
  actor: DispatchActor;
  decision: string;
  approvalId?: string;
  correlationId?: string;
  note?: string;
}): Promise<void> {
  try {
    await (prisma as any).auditLog?.create({
      data: {
        tenantId: opts.tenantId,
        action: "integration.dispatch_decision",
        entityType: "tool",
        entityId: opts.toolFunctionName,
        metadata: {
          tool: opts.toolFunctionName,
          actorType: opts.actor.type,
          decision: opts.decision,
          ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
          ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
          ...(opts.note ? { note: opts.note } : {}),
        },
      },
    });
  } catch {
    /* audit must never decide whether an action runs */
  }
}
