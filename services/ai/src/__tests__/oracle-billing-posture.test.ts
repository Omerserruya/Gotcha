import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY getBalance; the rest of shared stays real.
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getBalance: vi.fn() };
});

import { getBalance } from "@chatcenter/shared";
import { assembleOracleFacts } from "../services/agent-loop/oracle-assembler";
import { clearCapabilities } from "../services/capability-plane";

const opts = (tenantId: string) => ({
  ctx: { tenantId, conversationId: "c1" },
  base: { customer: { knownFields: {}, identityResolved: false }, permissions: { allowedOperations: [] } },
  now: "2026-07-03T00:00:00.000Z",
});

beforeEach(() => {
  vi.mocked(getBalance).mockReset();
  clearCapabilities(); // no domain reads - isolate the billing posture
});

describe("oracle billing posture - never silently fail OPEN", () => {
  it("healthy read: real balance flows into entitlements", async () => {
    vi.mocked(getBalance).mockResolvedValue({ total: 0 } as any);
    const facts = await assembleOracleFacts(opts("t-exhausted"));
    expect(facts.entitlements.withinLimits).toBe(false); // 0 credits = not within limits
  });

  it("read failure AFTER a known state: falls back to LAST KNOWN, not to healthy", async () => {
    vi.mocked(getBalance).mockResolvedValueOnce({ total: 0 } as any); // known: exhausted
    await assembleOracleFacts(opts("t-lkg"));
    vi.mocked(getBalance).mockRejectedValueOnce(new Error("billing down"));
    const facts = await assembleOracleFacts(opts("t-lkg"));
    // An exhausted tenant must NOT flip back to spendable because billing is unreadable.
    expect(facts.entitlements.withinLimits).toBe(false);
  });

  it("read failure with NO known state: degrades permissive (metered AI backstop) - cold start only", async () => {
    vi.mocked(getBalance).mockRejectedValue(new Error("billing down"));
    const facts = await assembleOracleFacts(opts("t-cold"));
    expect(facts.entitlements.withinLimits).toBe(true);
  });
});
