import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2 — integration tool dispatcher uses CatalogTool.endpoint/method
 * and actually performs an HTTP call with credential injection.
 */

const { axiosMock, prismaMock, analyticsQueueMock } = vi.hoisted(() => ({
  axiosMock: vi.fn(),
  prismaMock: {
    tenantTool: { findFirst: vi.fn() },
    toolExecution: { create: vi.fn().mockResolvedValue({ id: "te1" }) },
  } as any,
  analyticsQueueMock: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  analyticsQueue: analyticsQueueMock,
}));
vi.mock("../services/usage.service", () => ({ trackToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/audit.service", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../services/tool-execution.service";

describe("tool-execution.service — integration HTTP dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches to catalogTool.endpoint with correct method and auth", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({
      id: "tt1",
      isEnabled: true,
      configOverrides: {},
      catalogTool: {
        slug: "hubspot-create-contact",
        name: "Create Contact",
        endpoint: "https://api.hubspot.com/contacts",
        method: "POST",
        inputSchema: { required: ["email"] },
        category: "ACTION",
      },
      tenantIntegration: {
        credentials: { apiKey: "hs_key_123" },
        config: { headers: { "X-Portal": "42" } },
      },
    });
    axiosMock.mockResolvedValue({ status: 201, data: { id: "hs_99" } });

    const r = await executeTool({
      tenantId: "t1",
      conversationId: "conv1",
      tenantToolId: "tt1",
      input: { email: "a@b.co", name: "A" },
      triggeredBy: "ai",
    });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.output).toEqual({ id: "hs_99" });
    expect(axiosMock).toHaveBeenCalledTimes(1);
    const cfg = axiosMock.mock.calls[0]![0];
    expect(cfg.url).toBe("https://api.hubspot.com/contacts");
    expect(cfg.method).toBe("POST");
    expect(cfg.headers["Authorization"]).toBe("Bearer hs_key_123");
    expect(cfg.headers["X-Portal"]).toBe("42");
    expect(cfg.data).toEqual({ email: "a@b.co", name: "A" });
  });

  it("rejects missing required params from inputSchema — no silent fallback", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({
      id: "tt1",
      isEnabled: true,
      configOverrides: {},
      catalogTool: {
        slug: "hubspot-create-contact",
        endpoint: "https://api.hubspot.com/contacts",
        method: "POST",
        inputSchema: { required: ["email"] },
        category: "ACTION",
      },
      tenantIntegration: { credentials: {}, config: {} },
    });

    const r = await executeTool({
      tenantId: "t1",
      conversationId: "conv1",
      tenantToolId: "tt1",
      input: { name: "no-email" },
      triggeredBy: "ai",
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing required param: email/);
    expect(axiosMock).not.toHaveBeenCalled();
  });

  it("fails loudly when catalogTool.endpoint is missing", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({
      id: "tt1",
      isEnabled: true,
      configOverrides: {},
      catalogTool: { slug: "broken", endpoint: null, method: "GET", inputSchema: {}, category: "READ" },
      tenantIntegration: { credentials: {}, config: {} },
    });
    const r = await executeTool({
      tenantId: "t1",
      conversationId: "conv1",
      tenantToolId: "tt1",
      input: {},
      triggeredBy: "ai",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no endpoint configured/);
  });

  it("surfaces upstream 4xx with structured error", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({
      id: "tt1",
      isEnabled: true,
      configOverrides: {},
      catalogTool: {
        slug: "hubspot-lookup",
        endpoint: "https://api.hubspot.com/lookup",
        method: "GET",
        inputSchema: {},
        category: "READ",
      },
      tenantIntegration: { credentials: { apiKey: "k" }, config: {} },
    });
    axiosMock.mockRejectedValue({
      response: { status: 403, data: { error: "forbidden" } },
    });
    const r = await executeTool({
      tenantId: "t1",
      conversationId: "conv1",
      tenantToolId: "tt1",
      input: {},
      triggeredBy: "ai",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/upstream 403/);
  });

  it("substitutes URL :params from input", async () => {
    prismaMock.tenantTool.findFirst.mockResolvedValue({
      id: "tt1",
      isEnabled: true,
      configOverrides: {},
      catalogTool: {
        slug: "crm-get",
        endpoint: "https://api.crm.test/contacts/:contactId",
        method: "GET",
        inputSchema: { required: ["contactId"] },
        category: "READ",
      },
      tenantIntegration: { credentials: {}, config: {} },
    });
    axiosMock.mockResolvedValue({ status: 200, data: { id: "c9" } });
    const r = await executeTool({
      tenantId: "t1",
      conversationId: "conv1",
      tenantToolId: "tt1",
      input: { contactId: "c9" },
      triggeredBy: "ai",
    });
    expect(r.ok).toBe(true);
    const cfg = axiosMock.mock.calls[0]![0];
    expect(cfg.url).toBe("https://api.crm.test/contacts/c9");
  });
});
