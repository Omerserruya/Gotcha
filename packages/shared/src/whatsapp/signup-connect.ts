/**
 * The Meta steps of an Embedded Signup connect, shared by the tenant
 * `/api/channels/connect/whatsapp` and the platform alerts number
 * (`/api/system/platform-whatsapp/connect`). Lifted out of channels.ts on
 * 2026-11-15 with no behaviour change; whatsapp-connect-pin.test.ts pins the
 * tenant route call by call.
 *
 * Each step takes the caller's HTTP client, so a route's own axios (and its
 * test double) is what runs. Nothing here writes to a database: what a caller
 * persists, and under which tenant or none, stays the caller's.
 *
 * The register PIN is a parameter with no default. The tenant route passes
 * "000000" as it always has; the platform number passes a random one.
 */

export interface SignupHttp {
  get(url: string, config?: any): Promise<{ data: any }>;
  post(url: string, data?: any, config?: any): Promise<{ data: any }>;
}

export interface SignupConnectDeps {
  http: SignupHttp;
  /** Our configured Graph base, `metaGraphBaseUrl(...)`. */
  graphUrl: string;
  /** The Graph base of the version the FB JS SDK minted the popup code with. */
  sdkGraphUrl: string;
  appId: string;
  appSecret: string;
  /** Log prefix, e.g. "[WA-CONNECT]". */
  tag: string;
}

/**
 * Exchange the popup code for a business token.
 *
 * Four attempts, in this order, exactly as the tenant route always made them:
 * the FB.login popup code may be minted against the SDK's own Graph version,
 * so the exchange tries ours and the SDK's, GET and POST. `undefined` when
 * every attempt failed.
 */
export async function exchangeSignupCode(deps: SignupConnectDeps, code: string): Promise<string | undefined> {
  const { http, graphUrl, sdkGraphUrl, appId, appSecret, tag } = deps;
  const attempts: Array<{ label: string; method: "get" | "post"; url: string; data: any }> = [
    { label: "GET no redirect_uri", method: "get", url: `${graphUrl}/oauth/access_token`, data: { client_id: appId, client_secret: appSecret, code } },
    { label: "GET no redirect_uri v25", method: "get", url: `${sdkGraphUrl}/oauth/access_token`, data: { client_id: appId, client_secret: appSecret, code } },
    { label: "POST no redirect_uri", method: "post", url: `${graphUrl}/oauth/access_token`, data: { client_id: appId, client_secret: appSecret, code } },
    { label: "POST grant_type v25", method: "post", url: `${sdkGraphUrl}/oauth/access_token`, data: { client_id: appId, client_secret: appSecret, grant_type: "authorization_code", code } },
  ];
  for (const attempt of attempts) {
    try {
      console.log(`${tag} Trying: ${attempt.label}`);
      const tokenResponse = attempt.method === "get"
        ? await http.get(attempt.url, { params: attempt.data })
        : await http.post(attempt.url, attempt.data, { headers: { "Content-Type": "application/json" } });
      const tokenData = tokenResponse.data;
      const accessToken = typeof tokenData === "string" ? tokenData : tokenData.access_token;
      if (accessToken && typeof accessToken === "string" && accessToken.length > 10) {
        console.log(`${tag} Business token obtained with: ${attempt.label}`);
        return accessToken;
      }
    } catch (err: any) {
      console.warn(`${tag} Failed ${attempt.label}:`, err.response?.data?.error?.message);
    }
  }
  return undefined;
}

/** The token's WhatsApp-management WABA ids, from debug_token's granular scopes; [] on failure. */
export async function signupTokenWabaIds(deps: SignupConnectDeps, accessToken: string): Promise<string[]> {
  const { http, graphUrl, appId, appSecret, tag } = deps;
  try {
    const debugResponse = await http.get(`${graphUrl}/debug_token`, {
      params: { input_token: accessToken },
      headers: { Authorization: `Bearer ${appId}|${appSecret}` },
    });
    console.log(`${tag} debug_token:`, JSON.stringify(debugResponse.data?.data?.granular_scopes, null, 2));
    const granularScopes = debugResponse.data?.data?.granular_scopes || [];
    const wabaScope = granularScopes.find((s: any) => s.scope === "whatsapp_business_management");
    return wabaScope?.target_ids || [];
  } catch (debugErr: any) {
    console.warn(`${tag} debug_token failed:`, debugErr.response?.data?.error?.message);
    return [];
  }
}

/**
 * Subscribe our app to the WABA's webhooks. This is what makes inbound arrive;
 * a failure is returned, never thrown, so the caller can store an honest status.
 */
export async function subscribeSignupWaba(deps: SignupConnectDeps, wabaId: string, accessToken: string): Promise<{ subscribed: boolean; error: string | null }> {
  try {
    await deps.http.post(`${deps.graphUrl}/${wabaId}/subscribed_apps`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
    return { subscribed: true, error: null };
  } catch (subErr: any) {
    const error = subErr.response?.data?.error?.message || subErr.message || "webhook subscription failed";
    console.warn(`${deps.tag} Webhook subscription FAILED for WABA ${wabaId}:`, error);
    return { subscribed: false, error };
  }
}

/** The WABA's phone number ids. A Graph failure is thrown (the caller answers Meta's error). */
export async function listSignupPhoneIds(deps: SignupConnectDeps, wabaId: string, accessToken: string): Promise<string[]> {
  const phonesResponse = await deps.http.get(`${deps.graphUrl}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (phonesResponse.data?.data || []).map((p: any) => p.id);
}

/** id, display_phone_number, verified_name, quality_rating; `{ id }` alone when the read fails. */
export async function getSignupPhoneDetails(deps: SignupConnectDeps, phoneNumberId: string, accessToken: string): Promise<any> {
  try {
    const phoneResponse = await deps.http.get(`${deps.graphUrl}/${phoneNumberId}`, {
      params: { fields: "id,display_phone_number,verified_name,quality_rating" },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return phoneResponse.data;
  } catch (err: any) {
    console.warn(`${deps.tag} Failed to get details for phone ${phoneNumberId}:`, err.response?.data?.error?.message);
    return { id: phoneNumberId };
  }
}

/**
 * Register the number on the Cloud API with a two-step PIN. A failure (often
 * "already registered") is a note, not an error, as it always was for tenants.
 */
export async function registerSignupPhone(
  deps: SignupConnectDeps,
  phoneNumberId: string,
  accessToken: string,
  pin: string,
): Promise<{ registered: boolean; note: string | null }> {
  try {
    await deps.http.post(`${deps.graphUrl}/${phoneNumberId}/register`, { messaging_product: "whatsapp", pin }, { headers: { Authorization: `Bearer ${accessToken}` } });
    console.log(`${deps.tag} Registered phone ${phoneNumberId}`);
    return { registered: true, note: null };
  } catch (regErr: any) {
    const note = regErr.response?.data?.error?.message ?? regErr.message ?? null;
    console.warn(`${deps.tag} Phone registration note for ${phoneNumberId}:`, regErr.response?.data?.error?.message);
    return { registered: false, note };
  }
}
