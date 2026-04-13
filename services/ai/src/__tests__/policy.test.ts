import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY,
  getPolicy,
  setPolicy,
  validateAgainstPolicy,
  getPolicyPrompt,
} from "../services/policy.service";

describe("policy.service", () => {
  it("returns DEFAULT_POLICY when no tenant override exists", async () => {
    const p = await getPolicy("tenant-unknown");
    expect(p).toEqual(DEFAULT_POLICY);
  });

  it("setPolicy patches and getPolicy returns the patched shape", async () => {
    const next = await setPolicy("t1", { maxDiscountPercent: 25 });
    expect(next.maxDiscountPercent).toBe(25);
    expect(next.refundRequiresApproval).toBe(DEFAULT_POLICY.refundRequiresApproval);
    const fetched = await getPolicy("t1");
    expect(fetched.maxDiscountPercent).toBe(25);
  });

  it("validateAgainstPolicy blocks excess discounts on update_crm", () => {
    const result = validateAgainstPolicy(DEFAULT_POLICY, {
      tool: "update_crm",
      params: { discountPercent: 50 },
    });
    expect(result.ok).toBe(false);
  });

  it("validateAgainstPolicy passes low discount", () => {
    const result = validateAgainstPolicy(DEFAULT_POLICY, {
      tool: "update_crm",
      params: { discountPercent: 5 },
    });
    expect(result.ok).toBe(true);
  });

  it("getPolicyPrompt contains the max discount", async () => {
    const prompt = await getPolicyPrompt("tenant-unknown");
    expect(prompt).toContain(`${DEFAULT_POLICY.maxDiscountPercent}%`);
    expect(prompt).toContain("Business Policy");
  });
});
