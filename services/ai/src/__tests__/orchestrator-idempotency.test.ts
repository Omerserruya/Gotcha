import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Cross-turn idempotency (redelivery defense) in ActionOrchestrator.submit().
 * A redelivered inbound message that re-runs the SAME semantic side effect must
 * reuse the prior committed result from Redis instead of executing again.
 */

const { redisStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    redisMock: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, ..._rest: any[]) => {
        // emulate NX: don't overwrite an existing key
        if (_rest.includes("NX") && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }),
    },
  };
});

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    toolExecutionRequest: {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  evaluatePolicies: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "test" }),
  createApprovalRequest: vi.fn().mockResolvedValue({}),
  getRedis: () => redisMock,
}));

import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";
import type { ProposedAction } from "../services/orchestrator/types";
import { TurnOutcomeLedger } from "../services/turn-outcome-ledger";
import { classifySideEffect, semanticKey } from "../services/side-effect-classifier";

const TENANT = "t1";
const CONV = "conv1";
const ARGS = { meeting_type: "discovery_call", requested_at_iso: "2026-06-22T14:30:00Z", customer_email: "a@x.com" };

function bookingExec(eventId = "evt_1") {
  return {
    status: "completed",
    attempts: 1,
    result: { toolCallId: "tc_1", content: JSON.stringify({ ok: true, eventId }) },
  };
}

function action(id = "act1"): ProposedAction {
  return {
    id,
    conversationId: CONV,
    tenantId: TENANT,
    proposedBy: { mode: "chat", system: "test" },
    actor: { agentId: "" },
    tool: "schedule_meeting",
    args: ARGS,
    rationale: "test",
    urgency: "low" as const,
  };
}

function idemKey() {
  const key = semanticKey(classifySideEffect("schedule_meeting"), ARGS);
  return `idem:tool:${TENANT}:${CONV}:${key}`;
}

describe("ActionOrchestrator — cross-turn idempotency", () => {
  beforeEach(() => {
    redisStore.clear();
    redisMock.get.mockClear();
    redisMock.set.mockClear();
  });

  it("idempotency HIT: returns cached committed result without re-executing", async () => {
    redisStore.set(idemKey(), JSON.stringify(bookingExec("evt_cached")));
    const orch = new ActionOrchestrator();
    const ledger = new TurnOutcomeLedger();
    const executor = vi.fn().mockResolvedValue(bookingExec("evt_fresh").result);

    const out: any = await orch.submit(action(), executor, { ledger, idempotency: true });

    expect(executor).not.toHaveBeenCalled();
    expect(out.result.content).toContain("evt_cached");
    // ledger is seeded so within-turn consistency treats it as committed
    const key = semanticKey(classifySideEffect("schedule_meeting"), ARGS);
    expect(ledger.get(key)?.status).toBe("committed");
    expect(ledger.customerFacingCommitted().map((e) => e.kind)).toEqual(["booking"]);
  });

  it("idempotency MISS then persists a committed result (NX + EX)", async () => {
    const orch = new ActionOrchestrator();
    const ledger = new TurnOutcomeLedger();
    const executor = vi.fn().mockResolvedValue(bookingExec("evt_new").result);

    await orch.submit(action(), executor, { ledger, idempotency: true });

    expect(executor).toHaveBeenCalledTimes(1);
    // fire-and-forget persist — allow the microtask to flush
    await new Promise((r) => setTimeout(r, 5));
    expect(redisMock.set).toHaveBeenCalled();
    const setArgs = redisMock.set.mock.calls[0];
    expect(setArgs[0]).toBe(idemKey());
    expect(setArgs).toContain("EX");
    expect(setArgs).toContain("NX");
    expect(redisStore.get(idemKey())).toContain("evt_new");
  });

  it("idempotency DISABLED: never touches Redis", async () => {
    const orch = new ActionOrchestrator();
    const ledger = new TurnOutcomeLedger();
    const executor = vi.fn().mockResolvedValue(bookingExec().result);

    await orch.submit(action(), executor, { ledger }); // no idempotency flag
    await new Promise((r) => setTimeout(r, 5));

    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("a FAILED result is not persisted (a redelivery can still retry)", async () => {
    const orch = new ActionOrchestrator();
    const ledger = new TurnOutcomeLedger();
    const executor = vi.fn().mockResolvedValue({ toolCallId: "tc", content: JSON.stringify({ ok: false, reason: "agent_busy" }) });

    await orch.submit(action(), executor, { ledger, idempotency: true });
    await new Promise((r) => setTimeout(r, 5));

    expect(redisStore.has(idemKey())).toBe(false);
  });
});
