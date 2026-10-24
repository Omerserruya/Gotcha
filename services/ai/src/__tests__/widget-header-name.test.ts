/**
 * The website widget's header name (2026-10-24, Omer: "מאיה" stayed after the
 * employee changed). Through the real bootstrap route. Pinned:
 *   - nameSource "employee": the name of the employee the routing automation
 *     sends the web chat to, in both places the bundle reads it; change the
 *     automation and the name follows;
 *   - when the route names no one (no automation, paused, conditions), the
 *     typed name stays;
 *   - nameSource "custom", and every widget saved before the field: the typed
 *     name, whoever answers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ accounts: [] as any[], flows: [] as any[], agents: [] as any[] }));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "in" in v ? v.in.includes(r[k]) : r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async () => null,
    getRedis: () => ({ get: async () => null, set: async () => "OK" }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async () => ({}),
      },
      chatbotFlow: { findMany: async (a: any) => H.flows.filter((f) => f.tenantId === a.where.tenantId && f.isActive && f.triggerType === a.where.triggerType) },
      aIAgent: { findFirst: async (a: any) => H.agents.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null },
      flowCanvas: { findUnique: async () => null },
      whatsAppNumber: { findMany: async () => [] },
      businessProfile: { findUnique: async () => null },
      tenant: { findUnique: async () => ({ name: "Urban" }) },
      shopifyChatInstallation: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});

import { buildRoutingGraph } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); return a; };
const web = (credentials: any) => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED", platformMeta: null, lastHealthCheck: new Date(), credentials,
});
const routing = (employeeId: string, o: any = {}) => ({
  id: "flow_web", tenantId: "T", name: "Who answers the website chat", isActive: true, triggerType: "conversation_started",
  triggerConfig: { channels: ["WEBCHAT"] }, activatedAt: new Date(), ...buildRoutingGraph(employeeId), ...o,
});
const boot = async () => (await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" })).body.data.widget;
const typed = (nameSource?: string) => ({ v: 2, ...(nameSource ? { nameSource } : {}), ux: { welcome: { assistantName: "מאיה" } } });

beforeEach(() => {
  H.agents = [{ id: "ag_shark", tenantId: "T", name: "כריש" }, { id: "ag_yaara", tenantId: "T", name: "יערה" }];
  H.flows = [routing("ag_shark")];
});

describe("★ nameSource employee: the routed employee's name", () => {
  it("both places the bundle reads; changing the automation changes the name", async () => {
    H.accounts = [web(typed("employee"))];
    let w = await boot();
    expect(w.welcome.assistantName).toBe("כריש");
    expect(w.ux.welcome.assistantName).toBe("כריש");
    expect(w.nameSource).toBe("employee");
    H.flows = [routing("ag_yaara")];
    w = await boot();
    expect(w.welcome.assistantName).toBe("יערה");
  });

  it("the route names no one: the typed name stays", async () => {
    H.accounts = [web(typed("employee"))];
    for (const flows of [[], [routing("ag_shark", { isActive: false })], [routing("ag_gone")]]) {
      H.flows = flows;
      const w = await boot();
      expect(w.welcome.assistantName).toBe("מאיה");
      expect(w.nameSource).toBe("custom");
    }
  });
});

describe("custom, and every widget saved before the field", () => {
  it.each([["custom"], [undefined]])("nameSource %s: the typed name, whoever answers", async (src) => {
    H.accounts = [web(typed(src))];
    const w = await boot();
    expect(w.welcome.assistantName).toBe("מאיה");
    expect(w.ux.welcome.assistantName).toBe("מאיה");
    expect(w.nameSource).toBe("custom");
  });
});
