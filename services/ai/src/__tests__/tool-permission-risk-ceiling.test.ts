/**
 * Approval cannot be removed from an irreversible or money-moving action.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mayBeAlwaysAllowed` existed in the shared lib and NEITHER write path called
 * it. `PUT /api/tool-permissions/:toolName` stored `requiresApproval: false` on
 * `shopify.process_refund` on request, and the bulk migration `apply` wrote
 * `hitlPolicy.mode = "never"` for the same tool from a client-supplied state.
 *
 * A UI that only offers the choice for low-risk actions is a guard anybody with
 * curl steps over, and this is the endpoint that decides whether money can move
 * with nobody watching.
 *
 * ★ TWO writers, one request body. The single-tool route branches on whether the
 * tool is an integration tool: dotted names write
 * `configOverrides.hitlPolicy.mode` on TenantTool, static names write
 * `requiresApproval` on TenantToolPermission. The guard sits BEFORE the branch
 * so it cannot protect one and miss the other - the second is the one nobody
 * remembers.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { riskGroupFor, mayBeAlwaysAllowed } from "@chatcenter/shared";

const state = vi.hoisted(() => ({ writes: [] as any[] }));

vi.mock("@chatcenter/shared", async () => {
  // The REAL classifier and the REAL guard, imported from their own module
  // rather than through the barrel - the barrel opens a Redis connection at
  // import time. The point is that the route agrees with the real rule and not
  // with a stand-in that might be more permissive: a fake guard here would make
  // this whole file a decoration.
  const ta = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-availability");
  return {
    riskGroupFor: ta.riskGroupFor,
    mayBeAlwaysAllowed: ta.mayBeAlwaysAllowed,
    recommendedState: ta.recommendedState,
    RISK_GROUPS: ta.RISK_GROUPS,
    AuditAction: {},
    prisma: {
      tenantTool: {
        findFirst: async () => ({ id: "tt1", configOverrides: {} }),
        update: async (a: any) => { state.writes.push(["tenantTool.update", a.data]); return { id: "tt1" }; },
        create: async (a: any) => { state.writes.push(["tenantTool.create", a.data]); return { id: "tt1" }; },
      },
      tenantToolPermission: {
        upsert: async (a: any) => { state.writes.push(["permission.upsert", a.update]); return { id: "p1" }; },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    writeAudit: async () => undefined,
  };
});

import toolPermissionRoutes from "../routes/tool-permissions";

const app = express();
app.use(express.json());
app.use("/api/tool-permissions", toolPermissionRoutes);

const put = (tool: string, body: any) =>
  request(app).put(`/api/tool-permissions/${tool}`).send(body);

beforeEach(() => { state.writes = []; });

describe("★ the classification these rest on", () => {
  it("financial and delete tools may not be always-allowed", () => {
    expect(mayBeAlwaysAllowed(riskGroupFor("shopify.process_refund"))).toBe(false);
    expect(mayBeAlwaysAllowed(riskGroupFor("delete_customer"))).toBe(false);
  });

  it("a read-only tool may be", () => {
    expect(mayBeAlwaysAllowed(riskGroupFor("shopify.get_order"))).toBe(true);
  });
});

describe("★ approval cannot be removed from a money-moving action", () => {
  it("★ refuses requiresApproval:false on a refund, and writes NOTHING", async () => {
    const res = await put("shopify.process_refund", { requiresApproval: false });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("approval_cannot_be_removed");
    expect(res.body.riskGroup).toBe("financial");
    // A reason the screen can render, not a bare refusal.
    expect(res.body.message).toContain("process_refund");
    // The refusal must precede the write, not follow it.
    expect(state.writes).toHaveLength(0);
  });

  it("★ NO static registry tool is currently in a never-auto-approve group", () => {
    // So the guard's protection of the static branch is defensive and unreachable
    // TODAY - applying the real classifier to every name in TOOL_REGISTRY yields
    // no financial, delete or administrative tool. It is kept because the guard
    // sits above the branch (one placement, both writers) and the registry will
    // grow; stating it here so nobody reads a passing suite as proof that branch
    // was exercised.
    const staticNames = [
      "get_conversation", "send_message", "update_contact", "update_crm",
      "create_ticket", "tag_contact", "create_broadcast", "schedule_broadcast",
      "create_workflow", "merge_contacts", "link_customer_identifier",
      "create_task", "close_conversation", "escalate_to_human", "schedule_meeting",
    ];
    for (const n of staticNames) {
      expect(mayBeAlwaysAllowed(riskGroupFor(n)), `${n} is ${riskGroupFor(n)}`).toBe(true);
    }
  });

  it("★ cancel_order and create_return are NOT caught by the classifier", () => {
    // Verified rather than assumed, because it decides whether the guard covers
    // them: neither word appears in any of the four patterns, so both fall
    // through to `create_update` - the NO-MATCH fallback - and may be
    // always-allowed. Cancelling an order and issuing a return are both
    // irreversible and both move money, and the NEVER_AUTO_APPROVE comment
    // describes them while the pattern does not catch them.
    expect(riskGroupFor("shopify.cancel_order")).toBe("create_update");
    expect(riskGroupFor("shopify.create_return")).toBe("create_update");
    expect(mayBeAlwaysAllowed(riskGroupFor("shopify.cancel_order"))).toBe(true);
    expect(mayBeAlwaysAllowed(riskGroupFor("shopify.create_return"))).toBe(true);
    // Pinned as the CURRENT behaviour, not as the desired one. If the patterns
    // are widened this test should fail and be updated deliberately.
  });

  it("still allows TURNING APPROVAL ON for a risky tool", async () => {
    const res = await put("shopify.process_refund", { requiresApproval: true });

    // The ceiling is one-directional: tightening is always permitted.
    expect(res.status).toBe(200);
    expect(state.writes.length).toBeGreaterThan(0);
  });

  it("allows removing approval from a read-only tool", async () => {
    const res = await put("shopify.get_order", { requiresApproval: false });

    expect(res.status).toBe(200);
    expect(state.writes.length).toBeGreaterThan(0);
  });

  it("★ a body that does not mention requiresApproval is untouched by the guard", async () => {
    // Disabling a refund tool is not a request to remove its approval, and must
    // not be refused as though it were.
    const res = await put("shopify.process_refund", { enabled: false });

    expect(res.status).toBe(200);
  });

  it("is not fooled by a non-boolean falsy value", async () => {
    // `requiresApproval: 0` or "" must not read as an explicit false and slip
    // past a `=== false` check into a write that treats it as one.
    const res = await put("shopify.process_refund", { requiresApproval: 0 });

    expect(res.status).toBe(200);
    // ...and nothing wrote an approval change, because the route only acts on a
    // real boolean.
    const approvalWrites = state.writes.filter(([, d]) =>
      JSON.stringify(d).includes("hitlPolicy") || "requiresApproval" in (d ?? {}));
    expect(approvalWrites).toHaveLength(0);
  });
});
