/**
 * The guard that can stop the whole platform from starting.
 *
 * assertEnforcementConfigured runs inside startService(), which every HTTP
 * service calls, plus both workers and voice-copilot directly. It exists to
 * refuse a production configuration that fails open - but a guard this
 * load-bearing is two mistakes away from being an outage of its own: throw on a
 * value that is actually fine, and nothing boots.
 *
 * So both directions are tested, and the permissive direction matters more.
 * Refusing to start a misconfigured production stack is the feature. Refusing
 * to start a correctly configured one is a catastrophe.
 */
import { describe, it, expect } from "vitest";
import { assertEnforcementConfigured, getEnforcementMode } from "../entitlement-gate";

/** An explicit env, so nothing leaks in from the process running the tests. */
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ ...over }) as NodeJS.ProcessEnv;

describe("outside production it never gets in the way", () => {
  it.each([undefined, "", "off", "enforce", "nonsense", "HARD", "  "])(
    "starts with NODE_ENV unset and mode %o",
    (mode) => {
      // Development stacks routinely run unenforced and must keep working.
      expect(() => assertEnforcementConfigured(env({ BILLING_ENFORCEMENT_MODE: mode }))).not.toThrow();
    },
  );

  it.each(["development", "test", "staging"])("starts in NODE_ENV=%s with nothing set", (nodeEnv) => {
    expect(() => assertEnforcementConfigured(env({ NODE_ENV: nodeEnv }))).not.toThrow();
  });
});

describe("in production it refuses what fails open", () => {
  it("refuses to start with the mode unset", () => {
    // Unset means "off", and off in production means nobody has to pay - with
    // no symptom until an accountant finds it.
    expect(() => assertEnforcementConfigured(env({ NODE_ENV: "production" }))).toThrow(
      /BILLING_ENFORCEMENT_MODE is not set/,
    );
  });

  it.each(["enforced", "ENFORCE_", "on", "true", "strict", "hrd"])(
    "refuses the misspelling %o rather than falling back to off",
    (mode) => {
      // A typo here fails OPEN. Starting anyway is the dangerous choice.
      expect(() =>
        assertEnforcementConfigured(env({ NODE_ENV: "production", BILLING_ENFORCEMENT_MODE: mode })),
      ).toThrow(/is not a mode/);
    },
  );

  it("refuses an explicit off without an acknowledgement", () => {
    expect(() =>
      assertEnforcementConfigured(env({ NODE_ENV: "production", BILLING_ENFORCEMENT_MODE: "off" })),
    ).toThrow(/nobody is required to pay/);
  });

  it("allows an explicit off when someone has written it down", () => {
    // Deliberately awkward, not impossible: running production unenforced
    // should be a decision on the record rather than a default nobody saw.
    expect(() =>
      assertEnforcementConfigured(
        env({
          NODE_ENV: "production",
          BILLING_ENFORCEMENT_MODE: "off",
          BILLING_ALLOW_UNENFORCED: "true",
        }),
      ),
    ).not.toThrow();
  });

  it("does not accept a near-miss acknowledgement", () => {
    for (const ack of ["TRUE", "yes", "1", ""]) {
      expect(() =>
        assertEnforcementConfigured(
          env({
            NODE_ENV: "production",
            BILLING_ENFORCEMENT_MODE: "off",
            BILLING_ALLOW_UNENFORCED: ack,
          }),
        ),
      ).toThrow();
    }
  });
});

describe("every valid mode boots", () => {
  it.each(["enforce", "audit", "hard", "soft", "observe", "ENFORCE", " enforce "])(
    "starts production with %o",
    (mode) => {
      // The permissive direction, and the one that matters most: a guard that
      // rejected a correct value would take the platform down at the exact
      // moment someone was deploying the fix for something else.
      expect(() =>
        assertEnforcementConfigured(env({ NODE_ENV: "production", BILLING_ENFORCEMENT_MODE: mode })),
      ).not.toThrow();
    },
  );
});

describe("the message tells someone what to do", () => {
  it("names the variable and the value to set", () => {
    try {
      assertEnforcementConfigured(env({ NODE_ENV: "production" }));
      throw new Error("should have refused");
    } catch (err) {
      const msg = (err as Error).message;
      // Read at 3am by whoever is on call for a stack that will not start.
      expect(msg).toContain("BILLING_ENFORCEMENT_MODE");
      expect(msg).toContain("enforce");
    }
  });

  it("lists the accepted modes when one is misspelt", () => {
    try {
      assertEnforcementConfigured(env({ NODE_ENV: "production", BILLING_ENFORCEMENT_MODE: "hrd" }));
      throw new Error("should have refused");
    } catch (err) {
      expect((err as Error).message).toContain("enforce");
      expect((err as Error).message).toContain("hrd");
    }
  });
});

describe("the mode the guard permits is the mode the gate reads", () => {
  it.each([
    ["enforce", "enforce"],
    ["hard", "enforce"],
    ["audit", "audit"],
    ["soft", "audit"],
    ["observe", "audit"],
    ["off", "off"],
  ])("%o resolves to %o", (configured, expected) => {
    const original = process.env.BILLING_ENFORCEMENT_MODE;
    process.env.BILLING_ENFORCEMENT_MODE = configured;
    try {
      // A value that boots but resolves to something else would be the worst
      // outcome: the stack starts, looks configured, and enforces nothing.
      expect(getEnforcementMode()).toBe(expected);
    } finally {
      if (original === undefined) delete process.env.BILLING_ENFORCEMENT_MODE;
      else process.env.BILLING_ENFORCEMENT_MODE = original;
    }
  });
});
