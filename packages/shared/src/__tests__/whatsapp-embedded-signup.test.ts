/**
 * Embedded Signup launch parameters.
 *
 * Every case here maps to the defect that made GOTCHA open a DIFFERENT Meta
 * experience from the one Meta's own Launch Tool produces for the same
 * configuration: the frontend forcing `extras.version = "v3"` onto a v4
 * configuration, and the server sending an undocumented `setup.channel`.
 */
import { describe, it, expect } from "vitest";
import { buildEmbeddedSignupLaunch, embeddedSignupDialogUrl } from "../whatsapp";

const env = {
  META_APP_ID: "967741506053131",
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "905441638869914",
};

describe("v4, the default", () => {
  it("sends an EMPTY extras object", () => {
    // v4 takes its version from the Login for Business configuration. Anything
    // in extras either does nothing or pins an older experience.
    const launch = buildEmbeddedSignupLaunch(env);
    expect(launch.esVersion).toBe("v4");
    expect(launch.extras).toEqual({});
  });

  it("never sends a version key", () => {
    // THE bug: `version: "v3"` overrode a v4 configuration and produced the
    // wrong Meta screens.
    expect(buildEmbeddedSignupLaunch(env).extras).not.toHaveProperty("version");
  });

  it("never sends setup, and certainly not setup.channel", () => {
    // `setup` pre-fills customer details, which we do not do.
    // `setup: { channel: "WHATSAPP" }` was not a documented field at all.
    expect(buildEmbeddedSignupLaunch(env).extras).not.toHaveProperty("setup");
  });

  it("sends no featureType for the unified flow", () => {
    expect(buildEmbeddedSignupLaunch(env).extras).not.toHaveProperty("featureType");
  });

  it("sends no sessionInfoVersion", () => {
    // Documented for v2 only; v4 returns session info without being asked.
    expect(buildEmbeddedSignupLaunch(env).extras).not.toHaveProperty("sessionInfoVersion");
  });

  it("carries the fixed FB.login parameters", () => {
    const launch = buildEmbeddedSignupLaunch(env);
    expect(launch.responseType).toBe("code");
    expect(launch.overrideDefaultResponseType).toBe(true);
    expect(launch.appId).toBe("967741506053131");
    expect(launch.configId).toBe("905441638869914");
    expect(launch.configured).toBe(true);
  });
});

describe("reporting whether it can launch at all", () => {
  it("is not configured without a config id", () => {
    expect(buildEmbeddedSignupLaunch({ META_APP_ID: "1" }).configured).toBe(false);
  });

  it("is not configured without an app id", () => {
    expect(
      buildEmbeddedSignupLaunch({ WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "1" }).configured,
    ).toBe(false);
  });

  it("treats whitespace as absent rather than launching with a blank id", () => {
    expect(
      buildEmbeddedSignupLaunch({ META_APP_ID: "  ", WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "1" })
        .configured,
    ).toBe(false);
  });
});

describe("older versions, when explicitly configured", () => {
  it("names itself for v3", () => {
    const launch = buildEmbeddedSignupLaunch({ ...env, WHATSAPP_ES_VERSION: "v3" });
    expect(launch.extras).toEqual({ version: "v3" });
  });

  it("falls back to v4 for an unrecognised version rather than passing it through", () => {
    const launch = buildEmbeddedSignupLaunch({ ...env, WHATSAPP_ES_VERSION: "v9" });
    expect(launch.esVersion).toBe("v4");
    expect(launch.extras).toEqual({});
  });

  it("can reproduce a Launch Tool block that includes sessionInfoVersion", () => {
    // Escape hatch so the deployed payload can be made byte-identical to the
    // tool without editing code.
    const launch = buildEmbeddedSignupLaunch({ ...env, WHATSAPP_ES_SESSION_INFO_VERSION: "3" });
    expect(launch.extras).toEqual({ sessionInfoVersion: "3" });
  });

  it("can request Coexistence when a configuration enables it", () => {
    const launch = buildEmbeddedSignupLaunch({
      ...env,
      WHATSAPP_ES_FEATURE_TYPE: "whatsapp_business_app_onboarding",
    });
    expect(launch.extras).toEqual({ featureType: "whatsapp_business_app_onboarding" });
  });
});

describe("the server dialog URL matches the browser call", () => {
  const launch = buildEmbeddedSignupLaunch(env);
  const url = new URL(
    embeddedSignupDialogUrl({
      launch,
      redirectUri: "https://dev.gotcha.co.il/api/channels/oauth/callback",
      state: "state123",
      dialogVersion: "v24.0",
    }),
  );

  it("uses the same app and configuration", () => {
    expect(url.searchParams.get("client_id")).toBe(launch.appId);
    expect(url.searchParams.get("config_id")).toBe(launch.configId);
  });

  it("uses the same response parameters", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
  });

  it("omits extras entirely when v4 has nothing to send", () => {
    // Rather than an empty `extras={}`, which is noise on the URL.
    expect(url.searchParams.get("extras")).toBeNull();
  });

  it("serialises extras identically when there IS something to send", () => {
    const v3 = buildEmbeddedSignupLaunch({ ...env, WHATSAPP_ES_VERSION: "v3" });
    const u = new URL(
      embeddedSignupDialogUrl({
        launch: v3,
        redirectUri: "https://x.test/cb",
        state: "s",
        dialogVersion: "v24.0",
      }),
    );
    expect(JSON.parse(u.searchParams.get("extras")!)).toEqual(v3.extras);
  });
});
