/**
 * Capability Registry — the Runtime's capability plane.
 *
 * The ONE place the Agent Loop talks to for "what is the world?" and "do this
 * operation". The loop NEVER imports a concrete capability. Each capability
 * SELF-DESCRIBES its world (`describeWorld` → facts + summary + operations +
 * observations) and executes its own operations through the shared Capability
 * Runtime. A new capability = one `registerCapability(...)` call; the loop, the
 * Oracle assembler, and the Reasoner are untouched.
 *
 * Domain capabilities only. Kernel truth (identity, billing, permissions) is NOT
 * a capability — the Oracle assembler reads it directly.
 */

import type {
  CapabilityWorldView,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTrace,
  CapabilityLoopPolicy,
} from "@chatcenter/shared";

/** Identity/context for a capability's world read (never carries vendor detail). */
export interface CapabilityContext {
  tenantId: string;
  conversationId: string;
  aiAgentId?: string;
  customerExternalId?: string;
  customerEmail?: string;
}

/** A registered domain capability. Hooks must never throw fatally. */
export interface CapabilityRegistration {
  /** Stable capability name, e.g. "CALENDAR". */
  name: string;
  /** Does this capability own (and know how to execute) this operation id? */
  ownsOperation(operationId: string): boolean;
  /**
   * Self-describe this capability's current world-state: a `CapabilityWorldView`
   * with domain facts, an LLM-readable summary, the operations available RIGHT NOW
   * (gated by live world-state), and salient observations. The kernel treats this
   * opaquely.
   */
  describeWorld(ctx: CapabilityContext): Promise<CapabilityWorldView>;
  /** Execute one owned operation via the shared Capability Runtime (the executor). */
  execute?(req: ExecutionRequest): Promise<{ result: ExecutionResult; trace: ExecutionTrace }>;
  /** Per-capability loop bounds (tighten-only; composed by the driver). */
  loopPolicy?: CapabilityLoopPolicy;
}

const REGISTRY = new Map<string, CapabilityRegistration>();

/** Register (or replace) a capability by name. Idempotent per name. */
export function registerCapability(cap: CapabilityRegistration): void {
  REGISTRY.set(cap.name, cap);
}

/** Test seam: drop all registrations. */
export function clearCapabilities(): void {
  REGISTRY.clear();
}

export function registeredCapabilities(): CapabilityRegistration[] {
  return [...REGISTRY.values()];
}

/**
 * Every capability's self-described world view this tick (in parallel). A read
 * that throws degrades to a minimal empty view — never blocks the Oracle.
 */
export async function describeAllWorlds(ctx: CapabilityContext): Promise<CapabilityWorldView[]> {
  return Promise.all(
    registeredCapabilities().map((c) =>
      c.describeWorld(ctx).catch(
        (): CapabilityWorldView => ({ capability: c.name, summary: `${c.name}: unavailable`, facts: {}, operations: [] }),
      ),
    ),
  );
}

/**
 * Execute a proposed operation through its owning capability → the shared
 * Capability Runtime (the SOLE executor). An operation no capability owns becomes
 * an OBSERVABLE BLOCKED result (never a throw) so the loop can react and move on.
 */
export async function executeOperation(
  req: ExecutionRequest,
): Promise<{ result: ExecutionResult; trace: ExecutionTrace }> {
  const owner = registeredCapabilities().find((c) => c.ownsOperation(req.operation));
  if (!owner || !owner.execute) return blocked(req, "no_capability_owns_operation");
  try {
    return await owner.execute(req);
  } catch (err: any) {
    return blocked(req, `capability_error:${String(err?.message || err)}`, "FAILED");
  }
}

/** Loop policies of the capabilities that own any of the given operation names. */
export function engagedLoopPolicies(operationNames: string[]): CapabilityLoopPolicy[] {
  return registeredCapabilities()
    .filter((c) => c.loopPolicy && operationNames.some((op) => c.ownsOperation(op)))
    .map((c) => c.loopPolicy!);
}

function blocked(
  req: ExecutionRequest,
  reason: string,
  status: "BLOCKED" | "FAILED" = "BLOCKED",
): { result: ExecutionResult; trace: ExecutionTrace } {
  const result: ExecutionResult =
    status === "FAILED" ? { status: "FAILED", reason, recoverable: false } : { status: "BLOCKED", reason };
  const trace: ExecutionTrace = {
    operation: req.operation,
    capability: "UNKNOWN",
    mode: req.mode,
    invariants: [],
    optimizations: [],
    executed: false,
    result: status,
    reason,
  };
  return { result, trace };
}
