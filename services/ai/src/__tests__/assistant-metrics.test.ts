/**
 * The assistant says what the screens say, in the user's words:
 *   - ★ "waiting for a person" IS the analytics figure behind Home and the
 *     queue (asked through its API with the user's own token), never a status
 *     count; without a token it says the figure is unavailable, not a guess
 *   - ★ pending approvals use Home's definition (not past expiry)
 *   - ★ no status key / metric key / query reaches the model; results carry a label
 *   - steps are written for people, in the interface language
 *   - the prompt: answer in the question's language; never internal values
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ wheres: [] as any[], fetches: [] as any[], totalWaiting: 10 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const t = (model: string) => ({ count: async (a: any) => { H.wheres.push({ model, where: a.where }); return 7; } });
  return { ...actual, prisma: { conversation: t("conversation"), message: t("message"), approvalRequest: t("approvalRequest") } };
});

import { dispatchSystemToolCall, stepText, METRIC_LABELS } from "../services/system-tools.service";
import { buildAgentContext } from "../services/agent-context.service";

const call = (name: string, args: any = {}) => ({ id: "tc", function: { name, arguments: JSON.stringify(args) } });
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "u1", authToken: "user-token", ...o });
const ENUMS = /\b(OPEN|WAITING|CLOSED|PENDING|RESOLVED|ANY)\b/;

beforeEach(() => {
  H.wheres = []; H.fetches = []; H.totalWaiting = 10;
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    H.fetches.push({ url, auth: init?.headers?.Authorization });
    return { ok: true, json: async () => ({ data: [], nextCursor: null, totalWaiting: H.totalWaiting }) };
  });
});

describe("★ the same numbers as the screens", () => {
  it("waiting_for_person is the analytics queue's total, read with the user's token", async () => {
    const r = JSON.parse((await dispatchSystemToolCall(call("system_get_metric", { metric: "waiting_for_person" }), ctx())).content);
    expect(r).toEqual({ ok: true, value: 10, label: METRIC_LABELS.waiting_for_person!.en });
    expect(H.fetches).toEqual([{ url: expect.stringMatching(/\/api\/analytics\/queue\/items\?limit=1$/), auth: "Bearer user-token" }]);
    expect(H.wheres).toEqual([]); // never a local status count
  });

  it("the old 'waiting_conversations' key now means the same figure (it used to count status WAITING: 3 vs 21 vs 10)", async () => {
    H.totalWaiting = 12;
    const r = JSON.parse((await dispatchSystemToolCall(call("system_get_metric", { metric: "waiting_conversations" }), ctx())).content);
    expect(r.value).toBe(12);
  });

  it("without the user's token the figure is unavailable, never guessed", async () => {
    const r = JSON.parse((await dispatchSystemToolCall(call("system_get_metric", { metric: "waiting_for_person" }), ctx({ authToken: undefined }))).content);
    expect(r).toEqual({ ok: false, error: "this figure is not available right now" });
  });

  it("pending approvals: Home's definition, still actionable (not past expiry)", async () => {
    await dispatchSystemToolCall(call("system_get_metric", { metric: "pending_approvals" }), ctx());
    expect(H.wheres[0]).toEqual({ model: "approvalRequest", where: { tenantId: "T", status: "PENDING", expiresAt: { gt: expect.any(Date) } } });
  });

  it("conversation figures exclude setup rehearsals, as the screens do", async () => {
    await dispatchSystemToolCall(call("system_get_metric", { metric: "open_conversations" }), ctx());
    expect(H.wheres[0].where).toMatchObject({ isTest: false, NOT: { customerExternalId: { startsWith: "sandbox:" } } });
  });
});

describe("★ no internal values reach the model", () => {
  it("results carry words, not status keys, metric keys or the query", async () => {
    const outs = [
      await dispatchSystemToolCall(call("system_count_conversations", { status: "WAITING", channel: "WHATSAPP" }), ctx()),
      await dispatchSystemToolCall(call("system_count_conversations", { status: "OPEN" }), ctx()),
      ...await Promise.all(["waiting_for_person", "pending_approvals", "open_conversations", "closed_today", "inbound_messages_24h"]
        .map((metric) => dispatchSystemToolCall(call("system_get_metric", { metric }), ctx()))),
    ];
    for (const o of outs) {
      expect(o.content).not.toMatch(ENUMS);
      expect(o.content).not.toMatch(/waiting_for_person|pending_approvals|open_conversations|"where"/);
    }
    expect(JSON.parse(outs[0].content).label).toBe("conversations waiting for the customer to reply on whatsapp");
  });
});

describe("steps are written for people", () => {
  it("in the interface language, never a tool name", () => {
    expect(stepText("system_get_metric", { metric: "waiting_for_person" }, "en")).toBe("Counting the conversations waiting for your team");
    expect(stepText("system_get_metric", { metric: "waiting_for_person" }, "he")).toBe("סופר את השיחות שמחכות לצוות");
    expect(stepText("system_search_customers", {}, "en")).toBe("Searching customers");
    for (const n of ["system_count_conversations", "system_get_metric", "system_recent_activity", "integration_get_order"]) {
      expect(stepText(n, {}, "en")).not.toMatch(/system_|integration_/);
    }
  });
});

describe("language", () => {
  it("the prompt: answer in the question's language, fall back to the interface; never internal values", () => {
    const prompt = readFileSync(join(__dirname, "..", "prompts", "system-copilot.md"), "utf8");
    expect(prompt).toMatch(/language of the operator's most recent message/);
    expect(prompt).toMatch(/interface language given in the context block/);
    expect(prompt).toMatch(/Never show internal values/);
  });

  it("the context block names the interface language", async () => {
    const b = await buildAgentContext({ operator: { tenantId: "T", userId: "u1", locale: "he" }, client: null });
    expect(b.block).toMatch(/Interface language: Hebrew/);
  });
});
