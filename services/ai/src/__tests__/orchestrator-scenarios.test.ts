import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The 5 single-source-of-truth scenarios, proven deterministically at the
 * orchestrator.submit() + TurnOutcomeLedger seam where the logic lives. The
 * live LLM cannot be forced to emit duplicate tool calls on command, so these
 * exercise the exact code path a duplicate/parallel emission drives:
 *
 *   1. Duplicate schedule_meeting in one turn → exactly one event.
 *   2. create_lead + schedule_meeting → meeting is the only customer-facing
 *      outcome; CRM stays background/invisible.
 *   3. Duplicate create_lead → exactly one lead.
 *   4. schedule_meeting success then a failing duplicate → success authoritative.
 *   5. Claimed booking with no committed ledger entry → fabricated_claim.
 */

const { redisStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    redisMock: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, ..._rest: any[]) => {
        if (_rest.includes("NX") && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }),
    },
  };
});

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  // Business-policy hooks added to the orchestrator (round 3): benign stubs
  actionKindForTool: () => null,
  evaluateBusinessPolicy: async () => ({ decision: "ALLOWED", policyId: null, policyVersion: null, matchedRules: [], reasonCodes: [] }),
  revalidateBeforeExecution: async () => ({ ok: true, decision: "ALLOWED" }),

  prisma: {
    toolExecutionRequest: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  evaluatePolicies: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "test" }),
  createApprovalRequest: vi.fn().mockResolvedValue({}),
  getRedis: () => redisMock,
}));

import { ActionOrchestrator } from "../services/orchestrator/action-orchestrator";
import type { ProposedAction } from "../services/orchestrator/types";
import { TurnOutcomeLedger } from "../services/turn-outcome-ledger";
import { buildCommittedOutcomeBlock, evaluateReplyConsistency } from "../services/ledger-reply";

const TENANT = "t1";
const CONV = "conv1";

function action(tool: string, args: Record<string, any>, id: string): ProposedAction {
  return {
    id,
    conversationId: CONV,
    tenantId: TENANT,
    proposedBy: { mode: "chat", system: "test" },
    actor: { agentId: "" },
    tool,
    args,
    rationale: "test",
    urgency: "low" as const,
  };
}
const dispatch = (body: any) => ({ toolCallId: "tc", content: JSON.stringify(body) });

const BOOK_ARGS = { meeting_type: "discovery_call", requested_at_iso: "2026-06-22T14:30:00Z", customer_email: "a@x.com" };
const LEAD_ARGS = { email: "a@x.com", name: "A" };

let orch: ActionOrchestrator;
let ledger: TurnOutcomeLedger;
beforeEach(() => {
  redisStore.clear();
  orch = new ActionOrchestrator();
  ledger = new TurnOutcomeLedger();
});

describe("Scenario 1 - duplicate schedule_meeting in one turn → exactly one event", () => {
  it("the duplicate dedups; executor runs once; one committed booking", async () => {
    const exec = vi.fn().mockResolvedValue(dispatch({ ok: true, eventId: "evt_1" }));
    await orch.submit(action("schedule_meeting", BOOK_ARGS, "a1"), exec, { ledger, idempotency: true });
    // model emits the same booking again in the same turn (different call id)
    const second: any = await orch.submit(action("schedule_meeting", BOOK_ARGS, "a2"), exec, { ledger, idempotency: true });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(ledger.committed().filter((e) => e.kind === "booking")).toHaveLength(1);
    // duplicate returns the FIRST committed result, not a fresh/contradictory one
    expect(second.result.content).toContain("evt_1");
  });
});

describe("Scenario 2 - create_lead + schedule_meeting → meeting confirmed, CRM invisible", () => {
  it("only the booking is customer-facing; the lead is background", async () => {
    await orch.submit(action("integration_create_lead", LEAD_ARGS, "a1"), () => Promise.resolve(dispatch({ ok: true, leadId: "ld_1" })), { ledger, idempotency: true });
    await orch.submit(action("schedule_meeting", BOOK_ARGS, "a2"), () => Promise.resolve(dispatch({ ok: true, eventId: "evt_1" })), { ledger, idempotency: true });

    expect(ledger.committed()).toHaveLength(2);
    expect(ledger.customerFacingCommitted().map((e) => e.kind)).toEqual(["booking"]);

    const block = buildCommittedOutcomeBlock(ledger)!;
    expect(block).toContain("A meeting WAS booked this turn");
    expect(block).toContain("NEVER mention"); // CRM lead kept invisible
    expect(block).not.toMatch(/confirm.*lead/i);
  });
});

describe("Scenario 3 - duplicate create_lead → exactly one lead", () => {
  it("the duplicate dedups; executor runs once; one committed create", async () => {
    const exec = vi.fn().mockResolvedValue(dispatch({ ok: true, leadId: "ld_1" }));
    await orch.submit(action("integration_create_lead", LEAD_ARGS, "a1"), exec, { ledger, idempotency: true });
    await orch.submit(action("integration_create_lead", { email: "A@X.com ", name: "A" }, "a2"), exec, { ledger, idempotency: true }); // same identity, noisy formatting

    expect(exec).toHaveBeenCalledTimes(1);
    expect(ledger.committed().filter((e) => e.kind === "create")).toHaveLength(1);
  });
});

describe("Scenario 4 - booking success then a failing duplicate → success authoritative", () => {
  it("the failing duplicate never executes; the committed booking stands", async () => {
    const goodExec = vi.fn().mockResolvedValue(dispatch({ ok: true, eventId: "evt_1" }));
    const failExec = vi.fn().mockResolvedValue(dispatch({ ok: false, reason: "agent_busy" }));

    await orch.submit(action("schedule_meeting", BOOK_ARGS, "a1"), goodExec, { ledger, idempotency: true });
    const dupe: any = await orch.submit(action("schedule_meeting", BOOK_ARGS, "a2"), failExec, { ledger, idempotency: true });

    expect(failExec).not.toHaveBeenCalled(); // dedup short-circuits before execution
    const booking = ledger.get(ledger.committed()[0].semanticKey)!;
    expect(booking.status).toBe("committed");
    expect(dupe.result.content).toContain("evt_1"); // not the agent_busy failure
  });

  it("monotonic: even if a failure is recorded for the same key, it cannot downgrade the commit", async () => {
    // direct ledger proof - a later failed record never lowers a committed status
    await orch.submit(action("schedule_meeting", BOOK_ARGS, "a1"), () => Promise.resolve(dispatch({ ok: true, eventId: "evt_1" })), { ledger });
    const key = ledger.committed()[0].semanticKey;
    ledger.record({ semanticKey: key, tool: "schedule_meeting", kind: "booking", visibility: "customer_facing", status: "failed", result: { ok: false } });
    expect(ledger.get(key)!.status).toBe("committed");
  });
});

describe("Scenario 5 - claimed booking with no committed ledger entry → blocked", () => {
  it("a booking claim against an empty ledger is fabricated_claim", () => {
    const v = evaluateReplyConsistency(ledger, "You're all set for tomorrow at 14:30!", {
      bookingClaimMatched: true,
      replyNonAdvancing: false,
    });
    expect(v.status).toBe("fabricated_claim");
  });

  it("the same claim AFTER a real commit is ok (not a false positive)", async () => {
    await orch.submit(action("schedule_meeting", BOOK_ARGS, "a1"), () => Promise.resolve(dispatch({ ok: true, eventId: "evt_1" })), { ledger });
    const v = evaluateReplyConsistency(ledger, "You're all set for tomorrow at 14:30!", {
      bookingClaimMatched: true,
      replyNonAdvancing: false,
    });
    expect(v.status).toBe("ok");
  });
});
