import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * OAuth auto-refresh + retry-if-needed for framework integrations.
 *
 * The live bug (HubSpot): an OAuth access token expired, the integration latched
 * to ERROR, and the resolver/loadConnection only used CONNECTED integrations —
 * so the adapter was never instantiated, the token was never refreshed, and it
 * stayed ERROR forever (no lead ever created). These tests pin the recovery:
 *   - expired token refreshes proactively on use,
 *   - a 401 mid-call forces a refresh + retries ONCE,
 *   - an ERROR integration self-heals to CONNECTED on a successful refresh/use,
 *   - only a refresh FAILURE (revoked token) is a real, unrecoverable error.
 */

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const { row, prismaMock } = vi.hoisted(() => {
  const row: any = {
    id: "ti1",
    status: "CONNECTED",
    config: {},
    integration: { slug: "mockcrm" },
    credentials: { accessToken: "old", refreshToken: "rt", expiresAt: new Date().toISOString() },
  };
  return {
    row,
    prismaMock: {
      tenantIntegration: {
        findFirst: vi.fn(async ({ where }: any) => {
          const statuses = where?.status?.in ?? [where?.status];
          if (where?.integration?.slug !== "mockcrm") return null;
          if (!statuses.includes(row.status)) return null;
          return { ...row };
        }),
        update: vi.fn(async ({ data }: any) => {
          if (data.credentials !== undefined) row.credentials = data.credentials; // identity (encrypt mocked)
          if (data.status !== undefined) row.status = data.status;
          if (data.lastError !== undefined) row.lastError = data.lastError;
          return row;
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
  };
});

vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  encryptCredentials: (o: any) => o, // identity so the mock row stays an object
  decryptCredentials: (s: any) => s,
}));

import {
  executeAdapterTool,
  registerAdapter,
  __resetRateLimits,
  type ProviderAdapter,
} from "../services/connectors/integration-framework";

// Controllable mock adapter.
const execute = vi.fn();
const refreshTokens = vi.fn();
const mockAdapter: ProviderAdapter = {
  slug: "mockcrm",
  tools: () => [{
    name: "mockcrm.do", description: "d", whenToUse: "w",
    parameters: {}, category: "WRITE", riskLevel: "LOW",
  }],
  execute: (...a: any[]) => execute(...a),
  refreshTokens: (...a: any[]) => refreshTokens(...a),
};
registerAdapter(mockAdapter);

function call() {
  return executeAdapterTool({ tenantId: "t1", toolFunctionName: "mockcrm.do", args: {} });
}

beforeEach(() => {
  __resetRateLimits();
  execute.mockReset();
  refreshTokens.mockReset();
  prismaMock.tenantIntegration.findFirst.mockClear();
  prismaMock.tenantIntegration.update.mockClear();
  row.status = "CONNECTED";
  row.credentials = { accessToken: "old", refreshToken: "rt", expiresAt: FUTURE };
  row.lastError = undefined;
  refreshTokens.mockResolvedValue({ accessToken: "new", refreshToken: "rt2", expiresAt: new Date(Date.now() + 1_800_000) });
});

describe("executeAdapterTool — OAuth auto-refresh + retry", () => {
  it("expired token refreshes proactively on use (no 401 needed)", async () => {
    row.credentials.expiresAt = PAST;
    execute.mockResolvedValue({ done: true });
    const r = await call();
    expect(r).toEqual({ ok: true, result: { done: true } });
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0][0] as any).credentials.accessToken).toBe("new");
  });

  it("401 mid-call → forces refresh + retries ONCE → success", async () => {
    row.credentials.expiresAt = FUTURE; // looks fresh, so no proactive refresh
    execute.mockRejectedValueOnce(new Error("HubSpot 401 EXPIRED_AUTHENTICATION"));
    execute.mockResolvedValueOnce({ done: true });
    const r: any = await call();
    expect(r.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[1][0] as any).credentials.accessToken).toBe("new");
  });

  it("ERROR integration is LOADED, refreshed, and self-heals to CONNECTED", async () => {
    row.status = "ERROR";
    row.credentials.expiresAt = PAST;
    execute.mockResolvedValue({ done: true });
    const r: any = await call();
    expect(r.ok).toBe(true);
    expect(refreshTokens).toHaveBeenCalledTimes(1); // forced because ERROR
    expect(row.status).toBe("CONNECTED"); // recovered
  });

  it("refresh FAILURE (revoked token) → ok:false, stays ERROR", async () => {
    row.status = "ERROR";
    row.credentials.expiresAt = PAST;
    refreshTokens.mockRejectedValue(new Error("invalid_grant"));
    const r: any = await call();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/refresh/i);
    expect(execute).not.toHaveBeenCalled();
    expect(row.status).toBe("ERROR");
  });

  it("a retry that STILL 401s marks the integration ERROR", async () => {
    row.status = "CONNECTED";
    row.credentials.expiresAt = FUTURE;
    execute.mockRejectedValue(new Error("401 unauthorized")); // every call 401s
    const r: any = await call();
    expect(r.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2); // initial + one retry
    expect(row.status).toBe("ERROR");
  });
});
