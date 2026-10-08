/**
 * ★ propose_plan offers only actions an approved plan can really carry out.
 * It offered update_crm, update_contact, create_ticket and create_task, which
 * the executor runs against a stub that always fails: the owner approved a
 * plan that then failed (2026-10-08).
 *   - a step outside the list is refused before any approval exists
 *   - the tool's schema offers exactly the list, and no stub
 *   - every listed action has a real arm in the executor
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({ approvals: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createApprovalRequest: async (a: any) => { H.approvals.push(a); return { id: `apr_${H.approvals.length}` }; },
    evaluateToolGate: async () => ({ decision: "REQUIRE_APPROVAL", reason: "test" }),
    prisma: { tenantTool: { findMany: async () => [] } },
  };
});

import { dispatchSystemToolCall, buildSystemAgentTools, PLAN_ACTIONS } from "../services/system-tools.service";

const STUBS = ["update_crm", "update_contact", "create_ticket", "create_task"];
const plan = (steps: any[]) => dispatchSystemToolCall(
  { id: "p1", function: { name: "propose_plan", arguments: JSON.stringify({ summary: "Tag and update", steps }) } },
  { tenantId: "T", userId: "u" },
);

beforeEach(() => { H.approvals = []; });

describe("★ propose_plan: only what can run", () => {
  it("a plan with a stub step is refused before any approval exists, and says so", async () => {
    const r = await plan([{ tool: "tag_contact", params: {}, reason: "x" }, { tool: "update_crm", params: {}, reason: "y" }]);
    const out = JSON.parse(r.content);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain("update_crm");
    expect(H.approvals).toEqual([]);
    expect(r.sideEffect).toBeUndefined();
  });

  it("a plan of real actions is proposed", async () => {
    const r = await plan([{ tool: "tag_contact", params: { tag: "vip" }, reason: "x" }, { tool: "send_message", params: {}, reason: "y" }]);
    expect(JSON.parse(r.content)).toMatchObject({ ok: true, proposed_plan: true });
    expect(H.approvals).toHaveLength(1);
  });

  it("the schema offers exactly the list, never a stub", async () => {
    const tools = await buildSystemAgentTools({ tenantId: "T" });
    const pp: any = tools.find((t: any) => t.function?.name === "propose_plan");
    const step = pp.function.parameters.properties.steps.items.properties.tool;
    expect(step.enum).toEqual([...PLAN_ACTIONS]);
    const text = JSON.stringify(pp);
    for (const s of STUBS) expect(text).not.toContain(s);
    expect(pp.function.description).not.toMatch(/refunds, anything destructive/);
  });

  it("every listed action has a real arm in the executor (not the stub CRM)", () => {
    const src = readFileSync(join(__dirname, "../services/action-executor.service.ts"), "utf-8");
    for (const a of PLAN_ACTIONS) expect(src, a).toContain(`case "${a}"`);
    for (const s of STUBS) expect(PLAN_ACTIONS as readonly string[]).not.toContain(s);
  });
});
