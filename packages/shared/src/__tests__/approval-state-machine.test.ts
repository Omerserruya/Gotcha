/**
 * HITL state machine: the decision and the execution are separate states, and
 * the customer is told ONLY about a verified success, exactly once.
 *
 * Every case here maps to a way the previous implementation could hurt a real
 * customer: double execution from concurrent approvals, a "we did it" message
 * after a failed dispatch, or a duplicate confirmation on retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the approval_requests table with the CAS semantics
// Postgres gives us (updateMany applies only to rows matching the predicate).
type Row = Record<string, any>;
const rows = new Map<string, Row>();

function matches(row: Row, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v && !(v.in as any[]).includes(row[k])) return false;
      if ("gt" in v && !(row[k] > (v as any).gt)) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

// The helper imports `./prisma` directly, so THAT is the module to intercept
// (mocking the "@chatcenter/shared" barrel would not be in its import graph).
// The test lives in packages/shared precisely so these stay LOCAL imports: a
// service test reaching up into shared/src drags it into that service's
// tsconfig rootDir and breaks its build.
vi.mock("../lib/prisma", () => {
  const prisma = {
    approvalRequest: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            row[k] = v && typeof v === "object" && "increment" in (v as any)
              ? (row[k] ?? 0) + (v as any).increment
              : v;
          }
          count++;
        }
        return { count };
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        [...rows.values()].find((r) => matches(r, where)) ?? null),
    },
  };
  return { prisma, withCrossTenantAccess: (fn: any) => fn(), crossTenantMiddleware: {} };
});
vi.mock("../lib/event-bus", () => ({
  publishEvent: vi.fn(),
  subscribeToEvents: vi.fn(),
  closeEventBus: vi.fn(),
}));

const {
  approveRequest, rejectRequest, claimForExecution,
  recordExecutionOutcome, claimCustomerNotification,
} = await import("../lib/approval-requests");

const TENANT = "tenant-1";
function seedPending(id: string, overrides: Row = {}) {
  rows.set(id, {
    id, tenantId: TENANT, status: "PENDING",
    executionState: "NOT_STARTED", executionAttempts: 0,
    customerNotifiedAt: null, requestedBy: "bot",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

beforeEach(() => rows.clear());

describe("approval decision (atomic)", () => {
  it("only ONE of two concurrent approvals wins", async () => {
    seedPending("a1");
    const [first, second] = await Promise.all([
      approveRequest(TENANT, "a1", "manager-1"),
      approveRequest(TENANT, "a1", "manager-2"),
    ]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(rows.get("a1")!.status).toBe("APPROVED");
  });

  it("cannot approve an EXPIRED request (late WhatsApp/inbox click)", async () => {
    seedPending("a2", { expiresAt: new Date(Date.now() - 1000) });
    expect(await approveRequest(TENANT, "a2", "manager-1")).toBeNull();
    expect(rows.get("a2")!.status).toBe("PENDING");
  });

  it("cannot approve after rejection, and vice versa", async () => {
    seedPending("a3");
    expect(await rejectRequest(TENANT, "a3", "manager-1", "not appropriate")).not.toBeNull();
    expect(await approveRequest(TENANT, "a3", "manager-2")).toBeNull();
    expect(rows.get("a3")!.status).toBe("REJECTED");
  });

  it("is tenant-scoped - another tenant cannot decide this row", async () => {
    seedPending("a4");
    expect(await approveRequest("other-tenant", "a4", "intruder")).toBeNull();
    expect(rows.get("a4")!.status).toBe("PENDING");
  });

  it("records the decision channel for the audit trail", async () => {
    seedPending("a5");
    await approveRequest(TENANT, "a5", "manager-1", undefined, undefined, { decisionChannel: "whatsapp" });
    expect(rows.get("a5")!.decisionChannel).toBe("whatsapp");
  });
});

describe("execution claim", () => {
  it("only one worker can claim an approved request", async () => {
    seedPending("e1", { status: "APPROVED" });
    const [a, b] = await Promise.all([
      claimForExecution(TENANT, "e1"),
      claimForExecution(TENANT, "e1"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(rows.get("e1")!.executionState).toBe("EXECUTING");
    expect(rows.get("e1")!.executionAttempts).toBe(1);
  });

  it("a REJECTED request can never be claimed for execution", async () => {
    seedPending("e2", { status: "REJECTED" });
    expect(await claimForExecution(TENANT, "e2")).toBeNull();
    expect(rows.get("e2")!.executionState).toBe("NOT_STARTED");
  });

  it("a FAILED execution can be retried, a SUCCEEDED one cannot", async () => {
    seedPending("e3", { status: "APPROVED", executionState: "FAILED" });
    expect(await claimForExecution(TENANT, "e3")).not.toBeNull();

    seedPending("e4", { status: "APPROVED", executionState: "SUCCEEDED" });
    expect(await claimForExecution(TENANT, "e4")).toBeNull();
  });

  it("records success and failure outcomes distinctly", async () => {
    seedPending("e5", { status: "APPROVED" });
    await claimForExecution(TENANT, "e5");
    await recordExecutionOutcome(TENANT, "e5", { ok: true, result: { bookingId: "bk_1" } });
    expect(rows.get("e5")!.executionState).toBe("SUCCEEDED");
    expect(rows.get("e5")!.executionError).toBeNull();

    seedPending("e6", { status: "APPROVED" });
    await claimForExecution(TENANT, "e6");
    await recordExecutionOutcome(TENANT, "e6", { ok: false, error: "provider 502" });
    expect(rows.get("e6")!.executionState).toBe("FAILED");
    expect(rows.get("e6")!.executionError).toBe("provider 502");
  });
});

describe("customer notification (once, and only on real success)", () => {
  it("cannot be claimed while execution merely EXECUTING", async () => {
    seedPending("n1", { status: "APPROVED", executionState: "EXECUTING" });
    expect(await claimCustomerNotification(TENANT, "n1")).toBe(false);
  });

  it("cannot be claimed when execution FAILED - no false success message", async () => {
    seedPending("n2", { status: "APPROVED", executionState: "FAILED" });
    expect(await claimCustomerNotification(TENANT, "n2")).toBe(false);
    expect(rows.get("n2")!.customerNotifiedAt).toBeNull();
  });

  it("is granted exactly once after a SUCCEEDED execution", async () => {
    seedPending("n3", { status: "APPROVED", executionState: "SUCCEEDED" });
    const [a, b] = await Promise.all([
      claimCustomerNotification(TENANT, "n3"),
      claimCustomerNotification(TENANT, "n3"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // A later retry of the whole request must not message the customer again.
    expect(await claimCustomerNotification(TENANT, "n3")).toBe(false);
  });

  it("full happy path: approve → claim → succeed → notify once", async () => {
    seedPending("h1");
    expect(await approveRequest(TENANT, "h1", "manager-1")).not.toBeNull();
    expect(await claimCustomerNotification(TENANT, "h1")).toBe(false); // nothing executed yet
    expect(await claimForExecution(TENANT, "h1")).not.toBeNull();
    expect(await claimCustomerNotification(TENANT, "h1")).toBe(false); // still only EXECUTING
    await recordExecutionOutcome(TENANT, "h1", { ok: true, result: { ok: true } });
    expect(await claimCustomerNotification(TENANT, "h1")).toBe(true);  // now, once
    expect(await claimCustomerNotification(TENANT, "h1")).toBe(false);
  });
});
