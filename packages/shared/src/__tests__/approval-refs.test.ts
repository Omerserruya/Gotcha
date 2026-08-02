/**
 * WhatsApp one-tap approval handles.
 *
 * A reply-button id travels in cleartext to a phone, into Meta's logs, and
 * into any message backup. These tests lock the two properties that make that
 * acceptable: the handle carries NO business data, and it works exactly once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Redis stand-in with the semantics we actually depend on.
const kv = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const redis = {
  set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return "OK"; }),
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  getdel: vi.fn(async (k: string) => { const v = kv.get(k) ?? null; kv.delete(k); return v; }),
  del: vi.fn(async (...ks: string[]) => { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; sets.delete(k); } return n; }),
  sadd: vi.fn(async (k: string, m: string) => { const s = sets.get(k) ?? new Set(); s.add(m); sets.set(k, s); return 1; }),
  smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
  expire: vi.fn(async () => 1),
};
vi.mock("../lib/redis", () => ({ getRedis: () => redis, closeRedis: vi.fn() }));

const { mintApprovalRefs, consumeApprovalRef, revokeApprovalRefs, isApprovalRef, normalizeE164 } =
  await import("../lib/approval-refs");

const BINDING = {
  tenantId: "tenant-1",
  approvalId: "apr-1",
  recipientUserId: "user-9",
  tool: "issue_refund",
  channel: "whatsapp" as const,
};

beforeEach(() => { kv.clear(); sets.clear(); });

describe("handle contents", () => {
  it("is an opaque handle carrying no business data", async () => {
    const refs = await mintApprovalRefs(BINDING);
    for (const ref of Object.values(refs)) {
      expect(ref.startsWith("apv_")).toBe(true);
      // Nothing decodable: no tenant, tool, approval id, or user in the id.
      for (const secret of ["tenant-1", "apr-1", "user-9", "issue_refund", "refund"]) {
        expect(ref).not.toContain(secret);
      }
      // Comfortably inside WhatsApp's 256-char reply-button id limit.
      expect(ref.length).toBeLessThan(256);
    }
  });

  it("mints a distinct handle per decision", async () => {
    const refs = await mintApprovalRefs(BINDING);
    expect(refs.approve).not.toBe(refs.reject);
  });

  it("recognises only its own handles", () => {
    expect(isApprovalRef("apv_abc")).toBe(true);
    expect(isApprovalRef("hello")).toBe(false);
    expect(isApprovalRef(undefined)).toBe(false);
  });
});

describe("single use", () => {
  it("returns the full binding on first tap", async () => {
    const refs = await mintApprovalRefs(BINDING);
    const b = await consumeApprovalRef(refs.approve);
    expect(b).toMatchObject({ ...BINDING, decision: "approve" });
  });

  it("rejects a replayed tap of the same button", async () => {
    const refs = await mintApprovalRefs(BINDING);
    expect(await consumeApprovalRef(refs.approve)).not.toBeNull();
    expect(await consumeApprovalRef(refs.approve)).toBeNull();
  });

  it("revokes the OPPOSITE button once either is used", async () => {
    const refs = await mintApprovalRefs(BINDING);
    await consumeApprovalRef(refs.approve);
    // Tapping Reject a second later must not also register.
    expect(await consumeApprovalRef(refs.reject)).toBeNull();
  });

  it("rejects unknown and malformed handles", async () => {
    expect(await consumeApprovalRef("apv_nonexistent")).toBeNull();
    expect(await consumeApprovalRef("not-a-handle")).toBeNull();
  });

  it("revokeApprovalRefs kills both handles (decided in the UI instead)", async () => {
    const refs = await mintApprovalRefs(BINDING);
    await revokeApprovalRefs(BINDING.approvalId);
    expect(await consumeApprovalRef(refs.approve)).toBeNull();
    expect(await consumeApprovalRef(refs.reject)).toBeNull();
  });

  it("carries the decision so approve and reject cannot be confused", async () => {
    const refs = await mintApprovalRefs(BINDING);
    expect((await consumeApprovalRef(refs.reject))?.decision).toBe("reject");
  });
});

describe("normalizeE164", () => {
  it("accepts explicit international form", () => {
    expect(normalizeE164("+972 50-123-4567")).toBe("+972501234567");
    expect(normalizeE164("+1 (415) 555-0123")).toBe("+14155550123");
  });

  it("converts a national number when a country code is supplied", () => {
    expect(normalizeE164("0501234567", "972")).toBe("+972501234567");
    expect(normalizeE164("0501234567", "+972")).toBe("+972501234567");
  });

  it("refuses a national number with NO country code - a wrong number reaches a stranger", () => {
    expect(normalizeE164("0501234567")).toBeNull();
  });

  it("refuses junk, letters and implausible lengths", () => {
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("not a phone")).toBeNull();
    expect(normalizeE164("+123")).toBeNull();
    expect(normalizeE164("+1234567890123456789")).toBeNull();
  });
});
