/**
 * The plan's automation limit does not count the setup route (Omer, 2026-11-02).
 */
import { describe, it, expect, vi } from "vitest";

const rows = vi.hoisted(() => [
  { tenantId: "T", triggerConfig: { channels: [], origin: "setup" } },
  { tenantId: "T", triggerConfig: { channels: ["WHATSAPP"] } },
  { tenantId: "T", triggerConfig: null },
  { tenantId: "X", triggerConfig: {} },
]);
vi.mock("@chatcenter/shared", async () => ({
  SETUP_ORIGIN: "setup",
  prisma: {
    chatbotFlow: {
      count: async ({ where }: any) => rows.filter((r) => r.tenantId === where.tenantId
        && (!where.triggerConfig || (r.triggerConfig as any)?.[where.triggerConfig.path[0]] === where.triggerConfig.equals)).length,
    },
  },
}));

import { workflowsTowardLimit } from "../lib/workflow-limit";

describe("workflowsTowardLimit", () => {
  it("counts the workspace's automations and flows, minus the setup route", async () => {
    expect(await workflowsTowardLimit("T")).toBe(2);
  });
});
