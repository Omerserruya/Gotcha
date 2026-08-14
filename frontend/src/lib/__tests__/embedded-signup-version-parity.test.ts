/**
 * The browser SDK and the server must open the SAME Facebook dialog version.
 *
 * The frontend is not an npm workspace and cannot import `@chatcenter/shared`
 * at runtime, so the version exists as a literal in both places and this test
 * is what keeps them equal.
 *
 * Why it matters, found in production: with an identical app id, an identical
 * `config_id` and an empty `extras`, Meta's own Launch Tool link opened
 * `/v26.0/dialog/oauth` and offered "connect your WhatsApp Business app"
 * (Coexistence). Ours opened `/v25.0/dialog/oauth` and did not offer it at all.
 * No error, no warning - the choice simply was not rendered, and a customer
 * whose number lives in the WhatsApp Business app had no way through.
 *
 * The exchange is the second half: the SDK mints the authorization code against
 * its own version, and redeeming it against a different one can fail AFTER the
 * customer has already authorized. So a mismatch here is worse than the bug it
 * would be introduced to fix.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { FB_SDK_VERSION } from "../facebook-sdk";

const shared = readFileSync("../packages/shared/src/whatsapp/embedded-signup.ts", "utf8");
const channels = readFileSync("../services/auth/src/routes/channels.ts", "utf8");

function sharedDialogVersion(): string {
  const m = shared.match(/export const EMBEDDED_SIGNUP_DIALOG_VERSION = "(v\d+\.\d+)"/);
  if (!m) throw new Error("EMBEDDED_SIGNUP_DIALOG_VERSION not found in shared");
  return m[1];
}

describe("the dialog version is the same everywhere", () => {
  it("the browser SDK matches the shared constant", () => {
    expect(FB_SDK_VERSION).toBe(sharedDialogVersion());
  });

  it("is a real version, shaped the way Meta writes them", () => {
    expect(FB_SDK_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it("the token exchange tracks the SDK rather than the Graph API version", () => {
    // Redeeming against a version the code was not minted for fails after the
    // customer has already authorized, which is the worst place to fail.
    expect(channels).toMatch(/FB_JS_SDK_GRAPH_VERSION = EMBEDDED_SIGNUP_DIALOG_VERSION/);
    expect(channels).not.toMatch(/FB_JS_SDK_GRAPH_VERSION = "v\d+\.\d+"/);
  });

  it("the server redirect opens the dialog version, not the Graph version", () => {
    // metaGraphVersion() defaults to v24.0 and is a different concern entirely.
    // Passing it here made the redirect path and the popup path open two
    // different dialogs.
    expect(channels).toMatch(/dialogVersion: EMBEDDED_SIGNUP_DIALOG_VERSION/);
    expect(channels).not.toMatch(/dialogVersion: metaGraphVersion\(\)/);
  });

  it("is at least the version whose dialog offers the WhatsApp Business app path", () => {
    // v25.0 demonstrably did not render the Coexistence choice on this exact
    // configuration. Dropping below v26.0 would silently reintroduce that.
    const major = Number(FB_SDK_VERSION.slice(1).split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(26);
  });
});
