/**
 * A failed token refresh never stores or carries the provider's page.
 *
 * Dev, 2026-10-11: Shopify answered the refresh with its HTML 401 page, and
 * that page was written to tenant_integrations.last_error and thrown as the
 * reason every caller passed on (CRM panel, approvals, commerce panels).
 * Through the real ensureFreshToken, with the provider's exact text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ updates: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: { tenantIntegration: { update: vi.fn(async (a: any) => { H.updates.push(a); return {}; }) } },
    encryptCredentials: (x: any) => x,
    decryptCredentials: (x: any) => x,
  };
});

import { ensureFreshToken, describeRefreshFailure } from "../services/connectors/integration-framework";

const SHOPIFY_401 = "shopify_token_refresh_failed_401: <!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>unauthorized - Oauth error invalid_request</title>";

const adapter = (fail: unknown) => ({
  slug: "shopify",
  migratesLegacyCredentials: true,
  refreshTokens: vi.fn(async () => { throw fail; }),
}) as any;

beforeEach(() => {
  H.updates = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a refused token refresh", () => {
  it("stores [CODE] sentence in lastError, throws a clean message, logs the raw page", async () => {
    const err = await ensureFreshToken({
      tenantIntegrationId: "ti1",
      credentials: { accessToken: "a", refreshToken: "r" },
      adapter: adapter(new Error(SHOPIFY_401)),
      force: true,
      currentStatus: "ERROR",
    }).catch((e) => e);

    expect(H.updates).toHaveLength(1);
    expect(H.updates[0].data).toMatchObject({ status: "ERROR", lastError: "[CREDENTIALS_INVALID] The system rejected these credentials." });
    expect(err.message).toBe("Token refresh failed for shopify (401): [CREDENTIALS_INVALID] The system rejected these credentials.");
    for (const text of [H.updates[0].data.lastError, err.message]) expect(text).not.toMatch(/DOCTYPE|<html|<title|Oauth error/);
    const raw = (console.warn as any).mock.calls.find((c: any[]) => String(c[0]).includes("token refresh failed for shopify raw:"));
    expect(String(raw?.[1])).toContain("<!DOCTYPE html>");
  });

  it("keeps the signals the approval classifiers read: \"401\" and \"token\"", () => {
    const { message } = describeRefreshFailure("shopify", new Error(SHOPIFY_401));
    // conversation routes/approvals.ts toCustomerSafeReason: /scope|permission|forbidden|401|403/
    expect(/scope|permission|forbidden|401|403/.test(message.toLowerCase())).toBe(true);
    // frontend-v2 contracts/approvals.ts: /\b401\b|token|oauth|unauthori[sz]ed|reconnect/ -> 'connection'
    expect(/\b401\b|token|oauth|unauthori[sz]ed|reconnect/.test(message.toLowerCase())).toBe(true);
  });

  it("classifies by cause", () => {
    expect(describeRefreshFailure("hubspot", new Error("invalid_grant")).lastError).toBe("[CREDENTIALS_INVALID] The system rejected these credentials.");
    expect(describeRefreshFailure("zoho", new Error("zoho_refresh_503: <html>down</html>"))).toEqual({
      lastError: "[CONNECTION_FAILED] The system could not be reached.",
      message: "Token refresh failed for zoho (503): [CONNECTION_FAILED] The system could not be reached.",
    });
    expect(describeRefreshFailure("x", new Error("connect ECONNREFUSED 1.2.3.4:443")).lastError).toBe("[CONNECTION_FAILED] The system could not be reached.");
    expect(describeRefreshFailure("x", new Error("Unexpected token < in JSON at position 0"))).toEqual({
      lastError: "[TOKEN_REFRESH_FAILED] The connection's sign-in could not be renewed.",
      message: "Token refresh failed for x: [TOKEN_REFRESH_FAILED] The connection's sign-in could not be renewed.",
    });
  });
});
