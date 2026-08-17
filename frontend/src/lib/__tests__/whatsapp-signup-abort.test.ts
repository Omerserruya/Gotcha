/**
 * A signup that finished and produced nothing must not look like a cancel.
 *
 * Reported live: the customer completed the whole Embedded Signup, the popup
 * closed itself, and the panel quietly returned to its starting state. No
 * message, no error, and - because the code never arrived - no request to our
 * server either, so nothing in the logs to find afterwards. From the outside it
 * was indistinguishable from never having pressed the button.
 *
 * The cause was one branch treating "no authorization code" as "the customer
 * closed the popup", which is true often enough to look reasonable and hides
 * the case that actually needs reporting.
 */
import { describe, it, expect } from "vitest";
import {
  readAuthCode,
  classifySignupAbort,
  describeSignupResponse,
} from "../whatsapp-signup-flow";

describe("telling a dismissal from a failure", () => {
  it("treats a bare dismissal as a dismissal", () => {
    // What Meta sends when someone shuts the popup. Silence is right here.
    expect(classifySignupAbort({ status: "unknown", authResponse: null })).toBe("DISMISSED");
    expect(classifySignupAbort({ status: "unknown" })).toBe("DISMISSED");
    expect(classifySignupAbort(undefined)).toBe("DISMISSED");
    expect(classifySignupAbort({})).toBe("DISMISSED");
  });

  it("treats a completed flow with no code as a failure worth naming", () => {
    // The reported case: the flow ran, an authResponse came back, and there was
    // no code in it.
    expect(classifySignupAbort({ status: "connected", authResponse: {} })).toBe("NO_CODE");
    expect(classifySignupAbort({ status: "unknown", authResponse: { granted_scopes: "x" } })).toBe("NO_CODE");
    expect(classifySignupAbort({ status: "connected" })).toBe("NO_CODE");
  });

  it("still reads a real code, and an empty one is not a code", () => {
    expect(readAuthCode({ authResponse: { code: "AQB..." } })).toBe("AQB...");
    expect(readAuthCode({ authResponse: { code: "" } })).toBeNull();
    expect(readAuthCode({ status: "connected", authResponse: {} })).toBeNull();
  });
});

describe("the breadcrumb says enough and no more", () => {
  it("reports presence, never the secret itself", () => {
    const line = describeSignupResponse({
      status: "connected",
      authResponse: { code: "SECRET-CODE-VALUE", accessToken: "SECRET-TOKEN" },
    });
    expect(line).toContain("status=connected");
    expect(line).toContain("code=present");
    // The whole point of a breadcrumb is that it is safe to leave switched on.
    expect(line).not.toContain("SECRET-CODE-VALUE");
    expect(line).not.toContain("SECRET-TOKEN");
  });

  it("distinguishes an absent authResponse from an empty one", () => {
    expect(describeSignupResponse({ status: "unknown" })).toContain("authResponse=absent");
    expect(describeSignupResponse({ status: "connected", authResponse: {} })).toContain("authResponse=present");
  });

  it("survives junk without throwing", () => {
    // It runs on a failure path. Throwing here would replace a diagnosable
    // problem with an undiagnosable one.
    for (const junk of [null, undefined, 0, "", [], { authResponse: "not-an-object" }]) {
      expect(() => describeSignupResponse(junk)).not.toThrow();
    }
  });
});
