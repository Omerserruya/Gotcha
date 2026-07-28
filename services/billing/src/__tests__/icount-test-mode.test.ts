/**
 * Test mode reaches the real iCount API. These are the guards that make that
 * acceptable rather than reckless.
 *
 * The threat is not exotic. `test` uses the same client, the same transport and
 * the same endpoints as `live`; the ONLY thing separating a test terminal from
 * the production account is which token is configured. A token pasted into the
 * wrong .env would otherwise charge real cards from a developer's laptop, and
 * nothing in the code would have objected.
 *
 * So: the mode must be asked for explicitly, it must know which account it
 * expects, and the provider itself must confirm that account before anything is
 * written or charged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ICOUNT_")) delete process.env[k];
  }
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function config() {
  return import("../providers/icount-config");
}

describe("mode resolution", () => {
  it("defaults to mock, so an unconfigured stack can charge nothing", async () => {
    const { icountMode, isMock } = await config();
    expect(icountMode()).toBe("mock");
    expect(isMock()).toBe(true);
  });

  it("degrades test to mock without the acknowledgement", async () => {
    process.env.ICOUNT_MODE = "test";
    const { icountMode } = await config();
    // Not an error at this layer - a stack that merely names the mode has not
    // asked for it, and quietly reaching the network would be the surprise.
    expect(icountMode()).toBe("mock");
  });

  it("enables test only with ICOUNT_ALLOW_TEST", async () => {
    process.env.ICOUNT_MODE = "test";
    process.env.ICOUNT_ALLOW_TEST = "true";
    const { icountMode, isTest, isMock, isNetworkMode } = await config();
    expect(icountMode()).toBe("test");
    expect(isTest()).toBe(true);
    expect(isNetworkMode()).toBe(true);
    // The regression that would silently void the whole exercise: isMock() used
    // to mean "not live", so test mode would have taken every fixture path and
    // a "real" run would have proved nothing while passing.
    expect(isMock()).toBe(false);
  });

  it("keeps mock and simulator off the network", async () => {
    for (const mode of ["mock", "simulator"]) {
      vi.resetModules();
      process.env.ICOUNT_MODE = mode;
      process.env.ICOUNT_ALLOW_SIMULATOR = "true";
      const { isMock, isNetworkMode } = await config();
      expect(isMock(), mode).toBe(true);
      expect(isNetworkMode(), mode).toBe(false);
    }
  });

  it("still refuses live outside production", async () => {
    process.env.ICOUNT_MODE = "live";
    process.env.ICOUNT_ALLOW_LIVE = "true";
    const { icountMode, isLive } = await config();
    expect(icountMode()).toBe("live");
    expect(isLive()).toBe(true);
    // The provider-level guard is what refuses; asserted in the provider tests.
  });
});

describe("the startup gate", () => {
  const base = {
    ICOUNT_MODE: "test",
    ICOUNT_ALLOW_TEST: "true",
    ICOUNT_API_TOKEN: "t",
    ICOUNT_TEST_ACCOUNT_ID: "TESTACCT",
  } as NodeJS.ProcessEnv;

  it("accepts a fully configured test stack", async () => {
    const { assertIcountConfig } = await config();
    expect(() => assertIcountConfig({ ...base })).not.toThrow();
  });

  it("refuses test and live acknowledged together", async () => {
    const { assertIcountConfig } = await config();
    // These say opposite things about whose money moves. Picking one silently
    // is worse than refusing.
    expect(() => assertIcountConfig({ ...base, ICOUNT_ALLOW_LIVE: "true" })).toThrow(/opposite things/i);
  });

  it("refuses test without the acknowledgement", async () => {
    const { assertIcountConfig } = await config();
    expect(() => assertIcountConfig({ ...base, ICOUNT_ALLOW_TEST: "false" })).toThrow(/ICOUNT_ALLOW_TEST/);
  });

  it("refuses test with no token", async () => {
    const { assertIcountConfig } = await config();
    expect(() => assertIcountConfig({ ...base, ICOUNT_API_TOKEN: "" })).toThrow(/ICOUNT_API_TOKEN/);
  });

  it("refuses test with no expected account", async () => {
    const { assertIcountConfig } = await config();
    // Without this the mode is a label: nothing would stop the token belonging
    // to production.
    expect(() => assertIcountConfig({ ...base, ICOUNT_TEST_ACCOUNT_ID: "" })).toThrow(/ICOUNT_TEST_ACCOUNT_ID/);
  });

  it("refuses test in production", async () => {
    const { assertIcountConfig } = await config();
    expect(() => assertIcountConfig({ ...base, NODE_ENV: "production" })).toThrow(/production/);
  });

  it("leaves mock alone, which is what every dev stack and CI run uses", async () => {
    const { assertIcountConfig } = await config();
    expect(() => assertIcountConfig({ ICOUNT_MODE: "mock" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("the account gate", () => {
  it("does nothing outside test mode", async () => {
    process.env.ICOUNT_MODE = "mock";
    const { assertTestAccount } = await import("../providers/icount-client");
    await expect(assertTestAccount("cc/bill")).resolves.toBeUndefined();
  });

  it("refuses when no expected account is configured", async () => {
    process.env.ICOUNT_MODE = "test";
    process.env.ICOUNT_ALLOW_TEST = "true";
    process.env.ICOUNT_API_TOKEN = "t";
    const { assertTestAccount } = await import("../providers/icount-client");
    await expect(assertTestAccount("cc/bill")).rejects.toThrow(/ICOUNT_TEST_ACCOUNT_ID/);
  });
});

describe("what the client sends", () => {
  it("gates every write and charge on the account, and leaves reads open", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../providers/icount-client.ts", import.meta.url), "utf8"),
    );

    // Writes and money movements.
    for (const op of ["paypage/generate_sale", "client/create", "cc/bill", "doc/cancel"]) {
      const at = src.indexOf(`assertLiveTransport("${op}")`);
      expect(at, `${op} must assert transport`).toBeGreaterThan(-1);
      const after = src.slice(at, at + 200);
      expect(after, `${op} must verify the account before acting`).toContain(`assertTestAccount("${op}")`);
    }

    // Reads stay open deliberately: discovering which account a token resolves
    // to is how an operator diagnoses the very misconfiguration being guarded.
    for (const op of ["auth/info", "paypage/info", "cc/transactions"]) {
      const at = src.indexOf(`assertLiveTransport("${op}")`);
      expect(at, `${op} present`).toBeGreaterThan(-1);
      expect(src.slice(at, at + 200)).not.toContain("assertTestAccount");
    }
  });

  it("puts no credential or internal id in a return URL", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../routes/checkout-session.ts", import.meta.url), "utf8"),
    );
    const builder = src.slice(src.indexOf("function returnUrl"));
    expect(builder).toContain("buildReturnUrl");
    // Only the opaque reference travels.
    expect(builder).toContain("ref: reference");
    for (const forbidden of ["tenantId", "checkout.id", "token", "Bearer"]) {
      expect(builder, `${forbidden} must not reach a return URL`).not.toContain(forbidden);
    }
  });

  it("correlates the hosted session without depending on an unverified field", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../providers/icount-client.ts", import.meta.url), "utf8"),
    );
    // x_order_id is sent for provider-side reconciliation...
    expect(src).toContain("x_order_id");
    // ...but custom_client_id remains the handle everything is looked up by,
    // because that one is confirmed to survive the round trip.
    expect(src).toContain("custom_client_id: input.customClientId");
  });
});
