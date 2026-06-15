/**
 * Action Contract repo + progress reader.
 *
 * The BEL must stay pure (no I/O), so this is the only place that touches
 * Prisma for action-contract state. Callers load contracts + progress
 * BEFORE invoking computeBehaviorState() and pass them in.
 *
 *   - loadActionContracts(tenantId)   → all active contracts for the tenant
 *   - loadContractProgress(...)       → per-conversation completion state
 *   - markContractToolCompleted(...)  → write a tool-call into progress
 *   - markContractFulfilled(...)      → finalize a contract for this conv
 *
 * Failure mode: any DB error returns empty data and logs. Contracts are an
 * enforcement overlay - falling back to "no contracts" never makes the bot
 * misbehave on the prior path, so degrade gracefully.
 */

import { prisma } from "@chatcenter/shared";

export type ExecutionMode = "ALL_REQUIRED" | "SEQUENCE" | "AT_LEAST_ONE";

export interface ActionContract {
  id: string;
  tenantId: string;
  trigger: string;
  requiredTools: { name: string }[];
  executionMode: ExecutionMode;
  /** When SEQUENCE - the canonical execution order (falls back to requiredTools order). */
  order?: string[] | null;
  blocking: boolean;
  isActive: boolean;
}

export interface ActionContractProgress {
  id: string;
  contractId: string;
  conversationId: string;
  completedTools: string[];
  nextStepIndex: number;
  pausedReason: string | null;
  fulfilledAt: Date | null;
}

const cache = new Map<string, { value: ActionContract[]; expiresAt: number }>();
const TTL_MS = 60_000;

export async function loadActionContracts(tenantId: string): Promise<ActionContract[]> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: ActionContract[] = [];
  try {
    const rows = await (prisma as any).actionContract.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    value = rows.map(rowToContract);
  } catch (err: any) {
    if (!/Unknown arg|Cannot read|undefined.*findMany/.test(err?.message || "")) {
      console.warn("[action-contracts.repo] load failed:", err?.message);
    }
    value = [];
  }
  cache.set(tenantId, { value, expiresAt: now + TTL_MS });
  return value;
}

export function invalidateActionContractsCache(tenantId?: string): void {
  if (!tenantId) cache.clear();
  else cache.delete(tenantId);
}

export async function loadContractProgress(opts: {
  tenantId: string;
  conversationId: string;
  contractIds?: string[];
}): Promise<Map<string, ActionContractProgress>> {
  const out = new Map<string, ActionContractProgress>();
  try {
    const where: any = { tenantId: opts.tenantId, conversationId: opts.conversationId };
    if (opts.contractIds?.length) where.contractId = { in: opts.contractIds };
    const rows = await (prisma as any).actionContractProgress.findMany({ where });
    for (const r of rows) {
      out.set(r.contractId, {
        id: r.id,
        contractId: r.contractId,
        conversationId: r.conversationId,
        completedTools: Array.isArray(r.completedTools) ? r.completedTools : [],
        nextStepIndex: r.nextStepIndex ?? 0,
        pausedReason: r.pausedReason,
        fulfilledAt: r.fulfilledAt,
      });
    }
  } catch (err: any) {
    if (!/Unknown arg|Cannot read|undefined.*findMany/.test(err?.message || "")) {
      console.warn("[action-contracts.repo] progress load failed:", err?.message);
    }
  }
  return out;
}

/**
 * Idempotently mark a tool execution against a contract. Bumps the next
 * step index for SEQUENCE contracts. No-op if the tool was already recorded
 * for this (conversation, contract) - that gives free idempotency to the
 * dispatcher's retry path.
 */
export async function markContractToolCompleted(opts: {
  tenantId: string;
  conversationId: string;
  contract: ActionContract;
  toolName: string;
}): Promise<ActionContractProgress | null> {
  try {
    const existing = await (prisma as any).actionContractProgress.findUnique({
      where: { conversationId_contractId: { conversationId: opts.conversationId, contractId: opts.contract.id } },
    });
    const completed: string[] = existing?.completedTools && Array.isArray(existing.completedTools)
      ? existing.completedTools
      : [];
    if (completed.includes(opts.toolName)) {
      // Already recorded - return current.
      return rowToProgress(existing);
    }
    const nextCompleted = [...completed, opts.toolName];
    const nextIdx = computeNextStepIndex(opts.contract, nextCompleted);
    const fulfilled = isFulfilled(opts.contract, nextCompleted);

    const data = {
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      contractId: opts.contract.id,
      completedTools: nextCompleted,
      nextStepIndex: nextIdx,
      fulfilledAt: fulfilled ? new Date() : null,
    };
    const row = existing
      ? await (prisma as any).actionContractProgress.update({ where: { id: existing.id }, data })
      : await (prisma as any).actionContractProgress.create({ data });
    return rowToProgress(row);
  } catch (err: any) {
    console.warn("[action-contracts.repo] markCompleted failed:", err?.message);
    return null;
  }
}

export async function markContractPaused(opts: {
  conversationId: string;
  contractId: string;
  reason: string;
}): Promise<void> {
  try {
    await (prisma as any).actionContractProgress.update({
      where: { conversationId_contractId: { conversationId: opts.conversationId, contractId: opts.contractId } },
      data: { pausedReason: opts.reason },
    });
  } catch {
    /* non-fatal */
  }
}

// ─── Pure helpers (exported for BEL + dispatcher) ─────────────

export function isFulfilled(contract: ActionContract, completed: string[]): boolean {
  const required = contract.requiredTools.map((t) => t.name);
  if (contract.executionMode === "AT_LEAST_ONE") {
    return required.some((name) => completed.includes(name));
  }
  // ALL_REQUIRED + SEQUENCE both need every tool present.
  return required.every((name) => completed.includes(name));
}

export function computeNextStepIndex(contract: ActionContract, completed: string[]): number {
  if (contract.executionMode !== "SEQUENCE") return completed.length;
  const order = contract.order && contract.order.length
    ? contract.order
    : contract.requiredTools.map((t) => t.name);
  let i = 0;
  for (; i < order.length; i++) {
    if (!completed.includes(order[i])) break;
  }
  return i;
}

/**
 * For a SEQUENCE contract, the only "currently allowed" tool is the next
 * step in the ordered list. ALL_REQUIRED + AT_LEAST_ONE allow any pending
 * tool. Returns the set of tool names the dispatcher should accept.
 */
export function pendingToolsFor(contract: ActionContract, completed: string[]): string[] {
  const order = contract.order && contract.order.length
    ? contract.order
    : contract.requiredTools.map((t) => t.name);
  if (contract.executionMode === "SEQUENCE") {
    const idx = computeNextStepIndex(contract, completed);
    if (idx >= order.length) return [];
    return [order[idx]];
  }
  // ALL_REQUIRED / AT_LEAST_ONE: any not-yet-called tool is fair game.
  return order.filter((name) => !completed.includes(name));
}

// ─── Internals ────────────────────────────────────────────────

function rowToContract(r: any): ActionContract {
  const requiredTools = Array.isArray(r.requiredTools) ? r.requiredTools : [];
  // Normalize shape - tenants may write either `["x","y"]` or `[{name:"x"}]`.
  const norm: { name: string }[] = requiredTools.map((t: any) =>
    typeof t === "string" ? { name: t } : { name: String(t?.name ?? "") },
  ).filter((t: { name: string }) => t.name);
  return {
    id: r.id,
    tenantId: r.tenantId,
    trigger: r.trigger,
    requiredTools: norm,
    executionMode: (r.executionMode || "ALL_REQUIRED") as ExecutionMode,
    order: Array.isArray(r.order) ? (r.order as string[]) : null,
    blocking: r.blocking !== false,
    isActive: r.isActive !== false,
  };
}

function rowToProgress(r: any): ActionContractProgress {
  return {
    id: r.id,
    contractId: r.contractId,
    conversationId: r.conversationId,
    completedTools: Array.isArray(r.completedTools) ? r.completedTools : [],
    nextStepIndex: r.nextStepIndex ?? 0,
    pausedReason: r.pausedReason,
    fulfilledAt: r.fulfilledAt,
  };
}
