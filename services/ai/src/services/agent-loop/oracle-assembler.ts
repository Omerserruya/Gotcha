/**
 * Oracle Assembler - the modular Oracle for the Agent Loop.
 *
 * The Oracle is the ONLY source of truth. It assembles KERNEL facts (identity,
 * billing/entitlements, permissions - universal to every employee) plus the
 * DOMAIN world (each registered capability's self-described `CapabilityWorldView`),
 * then composes canonical `Facts` via the pure `assembleFacts` (which derives the
 * operation menu generically from the world). It re-runs every loop iteration so
 * Facts reflect the last operation's effect (re-read, never trust return values).
 *
 * Domain-agnostic: adding a capability changes NOTHING here - its world view flows
 * through `describeAllWorlds` untouched.
 */

import { assembleFacts, checkAiAllowed, getBalance, type DenyReason, type Facts, type KernelSignals } from "@chatcenter/shared";
import {
  ensureCapabilitiesRegistered,
  describeAllWorlds,
  type CapabilityContext,
} from "../capability-plane";
import { deriveAllowedOperations, type ToolGrants } from "./permissions-bridge";

export interface OracleBase {
  /** Customer identity - kernel truth owned by the turn, not a capability. */
  customer: KernelSignals["customer"];
  /** RBAC-permitted operations - the menu is intersected with these. */
  permissions: KernelSignals["permissions"];
}

export interface AssembleOracleOptions {
  ctx: CapabilityContext;
  base: OracleBase;
  /**
   * The agent's tool grants (RBAC home). When present, the allow-list is
   * derived from these against the LIVE world each tick - `base.permissions`
   * then only acts as an additional explicit ceiling if non-empty.
   */
  grants?: ToolGrants;
  /** ISO read time (no ambient clock in the composer). */
  now: string;
}

/**
 * Read the money home (kernel truth). Never throws. Failure posture: fail toward
 * the LAST KNOWN billing state for the tenant (never silently invent "healthy") -
 * a transient billing-read outage must not flip an exhausted tenant back to
 * spendable. Only with no prior knowledge at all (cold start / dev envs) does it
 * degrade to permissive, and then loudly. The metered AI choke point remains the
 * hard enforcement backstop either way.
 */
const LAST_KNOWN_BILLING = new Map<string, { billing: KernelSignals["billing"]; at: number }>();
const BILLING_FALLBACK_TTL_MS = 10 * 60 * 1000;

async function readBilling(tenantId: string): Promise<KernelSignals["billing"]> {
  try {
    // Balance is the HARD, fail-closed signal (credits + withinLimits): read it
    // from the wallet directly so a transient outage falls back to LAST KNOWN
    // (below) instead of silently flipping an exhausted tenant to spendable.
    const bal = await getBalance(tenantId);
    // Subscription STATUS (the previously-stubbed field) comes from the billing
    // home via checkAiAllowed - which encodes enforcement-mode semantics (off /
    // no-subscription / grandfathered → serviceable). It fail-OPENS by design
    // (never block a paying customer on a DB blip), so it only ever RELAXES the
    // status; the balance above stays the hard exhaustion signal. Best-effort:
    // a status-read failure leaves status "active" without failing the whole read.
    let status: KernelSignals["billing"]["status"] = "active";
    try {
      const allowance = await checkAiAllowed(tenantId);
      status = billingStatusFor(allowance.reason);
    } catch (statusErr: any) {
      console.warn(`[oracle] billing status read failed (${statusErr?.message}); defaulting status=active (balance remains the hard signal)`);
    }
    const billing: KernelSignals["billing"] = { status, credits: bal.total, withinLimits: bal.total > 0 };
    LAST_KNOWN_BILLING.set(tenantId, { billing, at: Date.now() });
    return billing;
  } catch (err: any) {
    const known = LAST_KNOWN_BILLING.get(tenantId);
    if (known && Date.now() - known.at < BILLING_FALLBACK_TTL_MS) {
      console.warn(`[oracle] billing read failed (${err?.message}); using last-known state for ${tenantId}`);
      return known.billing;
    }
    console.warn(`[oracle] billing read failed with NO known state for ${tenantId} (${err?.message}); degrading permissive - metered AI calls remain the enforcement backstop`);
    return { status: "active", withinLimits: true };
  }
}

/**
 * Assemble Facts: kernel truth (identity + billing + permissions) + the generic
 * domain world from every registered capability. Never throws.
 */
export async function assembleOracleFacts(opts: AssembleOracleOptions): Promise<Facts> {
  ensureCapabilitiesRegistered();

  const [billing, world] = await Promise.all([
    readBilling(opts.ctx.tenantId),
    describeAllWorlds(opts.ctx),
  ]);

  // RBAC: derive the allow-list from the agent's tool grants against the LIVE
  // menu (world may change between ticks). Falls back to the caller-provided
  // ceiling when no grants were loaded (tests / non-agent principals).
  const permissions = opts.grants
    ? {
        allowedOperations: deriveAllowedOperations(
          opts.grants,
          world.flatMap((w) => w.operations.map((o) => o.name)),
        ),
      }
    : opts.base.permissions;

  return assembleFacts({
    customer: opts.base.customer,
    billing,
    permissions,
    world,
    now: opts.now,
  });
}

/**
 * Map a refusal reason to the billing status the reasoning layer sees.
 *
 * Exhaustive on purpose. A reason that falls through to "active" tells the
 * reasoning layer that billing is fine for a tenant the runtime is refusing to
 * serve - which is worse than no signal at all, because it looks authoritative.
 * A new DenyReason is therefore a COMPILE error here rather than a silent
 * "active" discovered later in production.
 */
function billingStatusFor(reason: DenyReason | undefined): KernelSignals["billing"]["status"] {
  if (!reason) return "active";
  switch (reason) {
    case "suspended":
    case "canceled":
    case "tenant_suspended":
      return "suspended";
    case "units_exhausted":
    case "payment_required":
      return "past_due";
    default: {
      const never: never = reason;
      return never;
    }
  }
}
