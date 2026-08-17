/**
 * The ONE definition of how GOTCHA launches WhatsApp Embedded Signup.
 *
 * Why this module exists
 * ----------------------
 * There were two launch paths sending two different payloads:
 *
 *   frontend FB.login   extras: { version: "v3", setup: {} }
 *   server OAuth dialog extras: { setup: { channel: "WHATSAPP" } }
 *
 * Neither matched what Meta's own Launch Tool generates for the configuration,
 * so GOTCHA opened a different Embedded Signup experience from the working
 * Meta-hosted flow, and the two entry points did not even agree with each
 * other. Both now derive from this builder, and the frontend reads it from the
 * server rather than keeping its own copy, so they cannot drift again.
 *
 * Version selection is NOT a free choice
 * --------------------------------------
 * Per Meta's versions page, the version is chosen differently per version:
 *
 *   v4  set by the Facebook Login for Business CONFIGURATION; extras is empty
 *   v3  set in code:  extras.version = "v3"
 *   v2  set in code:  extras.version = "v2" (+ extras.sessionInfoVersion)
 *
 * We are on **v4**, so `extras` is empty and the configuration decides the
 * flow. Passing `version: "v3"` - as this codebase did - actively pins the
 * older experience and overrides whatever the configuration says. That was the
 * defect.
 *
 * `sessionInfoVersion` is deliberately NOT sent: Meta documents it for v2 only,
 * and v4 returns session info without it. The Launch Tool reporting "Session
 * Info Version: 3" describes what v4 SENDS BACK, not a parameter to pass.
 * If the Launch Tool's generated block does include it, set
 * `WHATSAPP_ES_SESSION_INFO_VERSION` rather than editing this file, so the
 * deployed value is always traceable to the tool.
 *
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions
 */

export type EmbeddedSignupVersion = "v2" | "v3" | "v4";

export interface EmbeddedSignupLaunch {
  /** Meta app that owns the configuration. */
  appId: string;
  /** Facebook Login for Business configuration id. */
  configId: string;
  /** Which Embedded Signup experience this produces. */
  esVersion: EmbeddedSignupVersion;
  responseType: "code";
  overrideDefaultResponseType: true;
  /** Passed verbatim to FB.login, and JSON-encoded for the dialog URL. */
  extras: Record<string, unknown>;
  /** True when app id and configuration id are both present. */
  configured: boolean;
}

/**
 * An index-signature type so `process.env` can be passed straight in. The
 * named keys below are documentation, not a closed set.
 */
export interface EmbeddedSignupEnv extends Record<string, string | undefined> {
  META_APP_ID?: string;
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID?: string;
  /** Escape hatch, only if the Launch Tool's block differs. `v4` by default. */
  WHATSAPP_ES_VERSION?: string;
  /** Only set this if the Launch Tool's generated block contains it. */
  WHATSAPP_ES_SESSION_INFO_VERSION?: string;
  /**
   * Only for the WhatsApp Business app (Coexistence) flow. Empty for the
   * normal unified v4 flow, which presents the supported choices itself.
   */
  WHATSAPP_ES_FEATURE_TYPE?: string;
}

/**
 * The Facebook dialog/SDK version Embedded Signup opens against.
 *
 * NOT the Graph API version and NOT the Embedded Signup version. This is the
 * `/vNN.N/dialog/oauth` path segment, and it decides which onboarding CHOICES
 * Meta's own dialog renders.
 *
 * Found the hard way: with an identical app id, an identical `config_id` and an
 * empty `extras`, Meta's Launch Tool link opened v26.0 and offered "connect
 * your WhatsApp Business app" (Coexistence), while ours opened v25.0 and did
 * not offer it at all. Same configuration, two different experiences, no error.
 *
 * Three things must move together, because the SDK mints the authorization code
 * against its own version and the exchange fails when they disagree:
 *   1. this constant (the server redirect dialog + the token exchange)
 *   2. FB_SDK_VERSION in frontend/src/lib/facebook-sdk.ts
 *   3. nothing else - META_GRAPH_VERSION is a separate concern and stays put
 * A parity test asserts 1 and 2 are equal, since the frontend cannot import it.
 */
export const EMBEDDED_SIGNUP_DIALOG_VERSION = "v26.0";

const DEFAULT_ES_VERSION: EmbeddedSignupVersion = "v4";

function parseVersion(raw: string | undefined): EmbeddedSignupVersion {
  const v = (raw || "").trim();
  return v === "v2" || v === "v3" || v === "v4" ? v : DEFAULT_ES_VERSION;
}

/**
 * Build the launch parameters.
 *
 * The `extras` rules below are Meta's, not ours:
 *
 *  * v4 sends an EMPTY extras object. Anything we add there either does
 *    nothing or silently downgrades the experience.
 *  * v3/v2 must name themselves in `extras.version`.
 *  * `setup` is for pre-filling the customer's details. We pre-fill nothing,
 *    so it is omitted entirely rather than sent as `{}` - and the old
 *    `setup: { channel: "WHATSAPP" }` was not a documented field at all.
 */
export function buildEmbeddedSignupLaunch(env: EmbeddedSignupEnv): EmbeddedSignupLaunch {
  const appId = (env.META_APP_ID || "").trim();
  const configId = (env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || "").trim();
  const esVersion = parseVersion(env.WHATSAPP_ES_VERSION);

  const extras: Record<string, unknown> = {};

  // v4 is configuration-driven and takes no version key. Naming a version here
  // is what pinned the old experience.
  if (esVersion !== "v4") extras.version = esVersion;

  // Documented for v2 only. Present solely so a Launch Tool block that
  // includes it can be reproduced exactly without a code change.
  const sessionInfoVersion = (env.WHATSAPP_ES_SESSION_INFO_VERSION || "").trim();
  if (sessionInfoVersion) extras.sessionInfoVersion = sessionInfoVersion;

  // Coexistence only. Meta enables that flow on the CONFIGURATION; this key
  // requests it and cannot compel it, so it stays unset for the unified flow.
  const featureType = (env.WHATSAPP_ES_FEATURE_TYPE || "").trim();
  if (featureType) extras.featureType = featureType;

  return {
    appId,
    configId,
    esVersion,
    responseType: "code",
    overrideDefaultResponseType: true,
    extras,
    configured: Boolean(appId && configId),
  };
}

/**
 * The same launch, as a `facebook.com/<ver>/dialog/oauth` URL.
 *
 * Used by the server-side redirect path. Built from the SAME object as the
 * browser's FB.login options so the two cannot describe different flows.
 *
 * `dialogVersion` is the Graph/dialog version in the URL path. It is unrelated
 * to the Embedded Signup version, which comes from the configuration.
 */
export function embeddedSignupDialogUrl(params: {
  launch: EmbeddedSignupLaunch;
  redirectUri: string;
  state: string;
  dialogVersion: string;
}): string {
  const { launch, redirectUri, state, dialogVersion } = params;
  const query = new URLSearchParams({
    client_id: launch.appId,
    config_id: launch.configId,
    redirect_uri: redirectUri,
    state,
    response_type: launch.responseType,
    override_default_response_type: String(launch.overrideDefaultResponseType),
  });
  // Only send `extras` when there is something in it. An empty `extras={}` on
  // the URL is noise, and v4's payload is empty by design.
  if (Object.keys(launch.extras).length > 0) {
    query.set("extras", JSON.stringify(launch.extras));
  }
  return `https://www.facebook.com/${dialogVersion}/dialog/oauth?${query.toString()}`;
}
