import { describe, it, expect } from "vitest";
import { mfaRequirementFor, isEnrolledWithRecovery } from "@chatcenter/shared";

const OFF = { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false };
const ADMINS = { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false };
const ALL = { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: true };
const BOTH = { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true };

describe("mfaRequirementFor - hierarchical MFA policy", () => {
  it("SYSTEM_ADMIN is ALWAYS required, regardless of tenant flags", () => {
    for (const p of [OFF, ADMINS, ALL, BOTH]) {
      const r = mfaRequirementFor("SYSTEM_ADMIN", p);
      expect(r.required).toBe(true);
      expect(r.reason).toBe("system_admin");
    }
  });

  it("ADMIN is not required when both flags are OFF", () => {
    expect(mfaRequirementFor("ADMIN", OFF)).toEqual({ required: false, reason: null });
  });

  it("ADMIN is required when mfaRequiredForAdmins is on (reason tenant_admins)", () => {
    expect(mfaRequirementFor("ADMIN", ADMINS)).toEqual({ required: true, reason: "tenant_admins" });
  });

  it("ADMIN is required when mfaRequiredForAllUsers is on (reason all_users)", () => {
    expect(mfaRequirementFor("ADMIN", ALL)).toEqual({ required: true, reason: "all_users" });
  });

  it("ADMIN: admins-flag takes reason precedence when both are on", () => {
    expect(mfaRequirementFor("ADMIN", BOTH)).toEqual({ required: true, reason: "tenant_admins" });
  });

  it("AGENT is NOT required under the admins-only policy", () => {
    expect(mfaRequirementFor("AGENT", ADMINS)).toEqual({ required: false, reason: null });
  });

  it("AGENT is required only under the all-users policy", () => {
    expect(mfaRequirementFor("AGENT", OFF)).toEqual({ required: false, reason: null });
    expect(mfaRequirementFor("AGENT", ALL)).toEqual({ required: true, reason: "all_users" });
    expect(mfaRequirementFor("AGENT", BOTH)).toEqual({ required: true, reason: "all_users" });
  });

  it("an unknown/other role behaves like AGENT (least-privilege)", () => {
    expect(mfaRequirementFor("VIEWER", ADMINS).required).toBe(false);
    expect(mfaRequirementFor("VIEWER", ALL).required).toBe(true);
  });
});

describe("isEnrolledWithRecovery - requires an authenticator AND recovery codes", () => {
  const dev = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

  it("false when nothing is set up", () => {
    expect(isEnrolledWithRecovery({ totp: [], passkeys: [], recoveryCodes: [] })).toBe(false);
  });

  it("false with an authenticator but NO recovery codes", () => {
    expect(isEnrolledWithRecovery({ totp: dev(1), passkeys: [], recoveryCodes: [] })).toBe(false);
    expect(isEnrolledWithRecovery({ totp: [], passkeys: dev(1), recoveryCodes: [] })).toBe(false);
  });

  it("false with recovery codes but NO authenticator", () => {
    expect(isEnrolledWithRecovery({ totp: [], passkeys: [], recoveryCodes: dev(1) })).toBe(false);
  });

  it("true with a TOTP and recovery codes", () => {
    expect(isEnrolledWithRecovery({ totp: dev(1), passkeys: [], recoveryCodes: dev(1) })).toBe(true);
  });

  it("true with a passkey and recovery codes", () => {
    expect(isEnrolledWithRecovery({ totp: [], passkeys: dev(1), recoveryCodes: dev(1) })).toBe(true);
  });

  it("tolerates missing arrays (undefined counts as empty)", () => {
    expect(isEnrolledWithRecovery({})).toBe(false);
  });
});
