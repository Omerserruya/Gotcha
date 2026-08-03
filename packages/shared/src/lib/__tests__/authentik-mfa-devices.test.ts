/**
 * "We could not ask the IdP" must never read as "this user has no devices".
 *
 * listUserDeviceRows() used to `catch { return [] }`. Every caller reads an
 * empty device list as NOT ENROLLED, so an unreachable - or, as happened in
 * production, an INVALID-credentials - Authentik made every user look
 * un-enrolled. Two consequences, neither of them visible:
 *
 *   1. /mfa-gate concluded the user had un-enrolled while still believing the
 *      read was live, and erased their mfaEnrolledAt stamp. A transient IdP
 *      error became permanent local state loss.
 *   2. The enrolment gate blocks the whole application until it clears, so a
 *      wrong AUTHENTIK_API_TOKEN presented as an MFA popup that came back after
 *      every successful enrolment, forever, with nothing in any log.
 *
 * The device rows themselves were never the problem - Authentik had them, and
 * had them confirmed. The lookup simply could not be performed and said
 * "none" instead of saying so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listUserDevices, getMfaEnrollmentMap } from "../authentik";

const realFetch = global.fetch;

/** Authentik returns full Django model paths, not friendly type names. */
const TOTP = "authentik_stages_authenticator_totp.TOTPDevice";
const STATIC = "authentik_stages_authenticator_static.StaticDevice";
const WEBAUTHN = "authentik_stages_authenticator_webauthn.WebAuthnDevice";

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  global.fetch = vi.fn(async (input: any) => {
    const { status, body } = handler(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as any;
  }) as any;
}

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("listUserDevices", () => {
  it("classifies Authentik's full model paths", async () => {
    stubFetch(() => ({
      status: 200,
      body: [
        { pk: 1, type: TOTP, name: "TOTP Authenticator", confirmed: true },
        { pk: 2, type: STATIC, name: "Static Token", confirmed: true },
        { pk: 3, type: WEBAUTHN, name: "Passkey", confirmed: true },
      ],
    }));
    const s = await listUserDevices(4);
    expect(s.totp).toHaveLength(1);
    expect(s.recoveryCodes).toHaveLength(1);
    expect(s.passkeys).toHaveLength(1);
  });

  it("ignores unconfirmed devices - a half-finished enrolment is not enrolled", async () => {
    stubFetch(() => ({
      status: 200,
      body: [
        { pk: 1, type: TOTP, name: "TOTP", confirmed: false },
        { pk: 2, type: STATIC, name: "Static", confirmed: true },
      ],
    }));
    const s = await listUserDevices(4);
    expect(s.totp).toHaveLength(0);
    expect(s.recoveryCodes).toHaveLength(1);
  });

  /**
   * The regression. 403 is the exact status a wrong API token returns, and it
   * must NOT come back as "no devices" - that is what locked the MFA gate.
   */
  it("throws on an IdP error instead of reporting an empty device list", async () => {
    stubFetch(() => ({ status: 403, body: { detail: "Token invalid/expired" } }));
    await expect(listUserDevices(4)).rejects.toThrow(/403/);
  });

  it("throws on a transport failure too", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    await expect(listUserDevices(4)).rejects.toThrow();
  });

  /** A genuinely empty list is still a valid, resolved answer. */
  it("returns empty for a user who really has no devices", async () => {
    stubFetch(() => ({ status: 200, body: [] }));
    const s = await listUserDevices(4);
    expect(s.totp).toHaveLength(0);
    expect(s.recoveryCodes).toHaveLength(0);
  });
});

describe("getMfaEnrollmentMap", () => {
  const SUBJECT = "bc8d54ef-e8f8-44e0-b6af-b7a2e60db367";
  const users = { results: [{ pk: 4, uuid: SUBJECT }] };

  it("reports resolved=false when the devices cannot be read", async () => {
    stubFetch((url) =>
      url.includes("/core/users/")
        ? { status: 200, body: users }
        : { status: 403, body: { detail: "Token invalid/expired" } },
    );
    const map = await getMfaEnrollmentMap([SUBJECT]);
    const state = map.get(SUBJECT);
    expect(state?.resolved, "an unreadable IdP must not masquerade as a resolved answer").toBe(false);
    expect(state?.enrolled).toBe(false);
  });

  it("reports resolved=true with a real answer when the IdP responds", async () => {
    stubFetch((url) =>
      url.includes("/core/users/")
        ? { status: 200, body: users }
        : { status: 200, body: [
            { pk: 1, type: TOTP, confirmed: true },
            { pk: 2, type: STATIC, confirmed: true },
          ] },
    );
    const map = await getMfaEnrollmentMap([SUBJECT]);
    const state = map.get(SUBJECT);
    expect(state?.resolved).toBe(true);
    expect(state?.enrolled).toBe(true);
  });
});
