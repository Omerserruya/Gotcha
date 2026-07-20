/**
 * `execution_result` is persisted to the DB and rendered in the approvals
 * inbox. A tool that echoes its own auth back (plenty do) would otherwise
 * write a live credential into a table that operators read casually.
 *
 * These lock the redaction: secrets never survive, the useful outcome always
 * does, and hostile shapes (deep nesting, huge strings, cycles-by-depth) can't
 * blow up the approve request.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {}, authenticate: vi.fn(), resolveTenant: vi.fn(), requireActiveTenant: () => vi.fn(),
  approveRequest: vi.fn(), rejectRequest: vi.fn(), claimForExecution: vi.fn(),
  recordExecutionOutcome: vi.fn(), claimCustomerNotification: vi.fn(), linkCustomerMessage: vi.fn(),
  findPendingByConversation: vi.fn(), publishEvent: vi.fn(), outgoingMessageQueue: { add: vi.fn() },
  getInternalServiceKey: () => "test-key",
  // Added when the internal dispatch-approved route landed; the mock must
  // cover every shared export approvals.ts imports or the module fails to load.
  requireInternalKey: (_req: any, _res: any, next: any) => next(),
  revalidateBeforeExecution: vi.fn(async () => ({ ok: true, decision: "ALLOWED" })),
}));

import { sanitizeExecutionResult } from "../routes/approvals";

describe("sanitizeExecutionResult", () => {
  it("redacts credential-bearing keys at any depth", () => {
    const out: any = sanitizeExecutionResult({
      ok: true,
      bookingId: "bk_123",
      accessToken: "ya29.super-secret",
      nested: { refreshToken: "1//refresh", apiKey: "sk_live_abc", authorization: "Bearer xyz" },
      deeper: { a: { password: "hunter2", secret: "s3cr3t" } },
    });
    expect(out.accessToken).toBe("[redacted]");
    expect(out.nested.refreshToken).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested.authorization).toBe("[redacted]");
    expect(out.deeper.a.password).toBe("[redacted]");
    expect(out.deeper.a.secret).toBe("[redacted]");
    // The part an operator actually needs survives.
    expect(out.ok).toBe(true);
    expect(out.bookingId).toBe("bk_123");
  });

  it("matches secret keys case-insensitively and across naming styles", () => {
    const out: any = sanitizeExecutionResult({
      API_KEY: "a", "api-key": "b", Authorization: "c", refresh_token: "d", clientSecret: "e",
    });
    for (const v of Object.values(out)) expect(v).toBe("[redacted]");
  });

  it("caps long strings and wide arrays so one tool cannot bloat the row", () => {
    const out: any = sanitizeExecutionResult({
      blob: "x".repeat(5000),
      items: Array.from({ length: 100 }, (_, i) => i),
    });
    expect(out.blob.length).toBe(500);
    expect(out.items.length).toBe(10);
  });

  it("stops at a bounded depth instead of recursing forever", () => {
    let deep: any = { leaf: "value" };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(() => sanitizeExecutionResult(deep)).not.toThrow();
    expect(sanitizeExecutionResult(deep)).toBeTypeOf("object");
  });

  it("passes through primitives and nullish safely", () => {
    expect(sanitizeExecutionResult(null)).toBeNull();
    expect(sanitizeExecutionResult(undefined)).toBeNull();
    expect(sanitizeExecutionResult(42)).toBe(42);
    expect(sanitizeExecutionResult(true)).toBe(true);
    expect(sanitizeExecutionResult("short")).toBe("short");
  });
});
