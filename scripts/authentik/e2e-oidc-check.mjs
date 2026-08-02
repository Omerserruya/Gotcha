#!/usr/bin/env node
/**
 * End-to-end OIDC verification against a live Authentik.
 *
 * Drives a real Authorization Code + PKCE login (identification -> password ->
 * authorize -> code -> token) and then verifies the resulting access token the
 * exact way the backend does, via JWKS. This is the proof that the whole chain
 * works, not just that the pieces exist.
 *
 * Usage: node scripts/authentik/e2e-oidc-check.mjs <email> <password>
 */
import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const BASE = process.env.AUTHENTIK_URL_PUBLIC || "http://localhost:9000";
const CLIENT_ID = process.env.OIDC_CLIENT_ID || "gotcha-app";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "http://localhost:3000/auth/callback";
const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];

if (!EMAIL || !PASSWORD) {
  console.error("usage: e2e-oidc-check.mjs <email> <password>");
  process.exit(1);
}

// --- tiny cookie jar (node fetch has none) ---
const jar = new Map();
function saveCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function req(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: { Cookie: cookieHeader(), ...(options.headers || {}) },
  });
  saveCookies(res);
  return res;
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

async function main() {
  // PKCE: S256 only. `plain` is advertised by Authentik but offers no
  // protection - the verifier would travel in the clear.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authorizeUrl =
    `${BASE}/application/o/authorize/?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

  // 1. Hit authorize unauthenticated -> Authentik parks us in a login flow.
  let res = await req(authorizeUrl);
  console.log(`[1] authorize -> ${res.status}`);

  const FLOW = "default-authentication-flow";
  const execUrl = `${BASE}/api/v3/flows/executor/${FLOW}/?query=${encodeURIComponent(new URL(authorizeUrl).search.slice(1))}`;

  // 2. Prime the flow, then answer each stage in turn.
  res = await req(execUrl, { headers: { Accept: "application/json" } });
  let body = await res.json();
  console.log(`[2] flow start -> ${body.component}`);

  // Each stage POST answers the current stage and 302s; the next stage is then
  // read with a fresh GET of the executor.
  async function answer(payload) {
    const r = await req(execUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const read = async (resp) => {
      const loc = resp.headers.get("location");
      if (loc && resp.status >= 300 && resp.status < 400) {
        // A 302 back to the executor itself just means "the next stage is
        // ready, come read it" - not the end of the flow. Only a redirect
        // pointing somewhere else is terminal.
        if (loc.includes("/flows/executor/")) return null;
        return { component: "xak-flow-redirect", to: loc };
      }
      const t = await resp.text();
      if (!t) return null;
      return JSON.parse(t);
    };

    let out = await read(r);
    if (out) return out;
    // The executor may 302 to itself a couple of times while it advances the
    // plan (running the MFA-validate and user-login stages). Poll until it
    // hands back an actual stage.
    for (let i = 0; i < 4; i++) {
      const g = await req(execUrl, { headers: { Accept: "application/json" } });
      out = await read(g);
      if (out) return out;
    }
    throw new Error("Executor never returned a stage");
  }

  for (let i = 0; i < 8; i++) {
    if (body.component === "ak-stage-identification") {
      body = await answer({ component: body.component, uid_field: EMAIL });
    } else if (body.component === "ak-stage-password") {
      body = await answer({ component: body.component, password: PASSWORD });
    } else if (body.component === "xak-flow-redirect") {
      console.log(`[3] login flow complete`);
      break;
    } else {
      throw new Error(`Unexpected stage: ${body.component} ${JSON.stringify(body).slice(0, 200)}`);
    }
    console.log(`    -> ${body.component}`);
  }

  if (body.component !== "xak-flow-redirect") throw new Error("Flow did not complete");

  // 3. Re-enter authorize now that the session cookie exists. Authentik hands
  // off to the authorization flow, which is driven through its own executor
  // and terminates by redirecting to our callback with the code.
  await req(authorizeUrl, { headers: { Accept: "text/html" } });

  const consentExec =
    `${BASE}/api/v3/flows/executor/default-provider-authorization-implicit-consent/?query=` +
    encodeURIComponent(new URL(authorizeUrl).search.slice(1));

  let code = null;
  for (let i = 0; i < 4 && !code; i++) {
    const r = await req(consentExec, { headers: { Accept: "application/json" } });
    const t = await r.text();
    if (!t.includes("xak-flow-redirect")) continue;
    const to = JSON.parse(t).to;
    const u = new URL(to.startsWith("http") ? to : `${BASE}${to}`);
    code = u.searchParams.get("code");
    if (code) {
      if (u.searchParams.get("state") !== state) throw new Error("STATE MISMATCH - CSRF check failed");
      console.log("[4] got authorization code, state verified");
    }
  }
  if (!code) throw new Error("No authorization code obtained");

  // 4. Exchange the code. Public client: no secret, verifier proves possession.
  const tokenRes = await fetch(`${BASE}/application/o/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
  console.log(`[5] token exchange OK (scopes: ${tokens.scope})`);

  // 5. Verify exactly as the backend does.
  const issuer = `${BASE}/application/o/gotcha/`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}jwks/`));
  const { payload } = await jwtVerify(tokens.access_token, jwks, {
    issuer,
    algorithms: ["RS256"],
  });
  console.log(`[6] ACCESS TOKEN VERIFIED VIA JWKS`);
  console.log(`    sub   = ${payload.sub}`);
  console.log(`    email = ${payload.email}`);

  // 6. Negative check: a tampered token must be rejected.
  const [h, p] = tokens.access_token.split(".");
  const forged = `${h}.${p}.${"A".repeat(342)}`;
  try {
    await jwtVerify(forged, jwks, { issuer, algorithms: ["RS256"] });
    console.log("[7] FAIL: forged signature ACCEPTED");
    process.exit(1);
  } catch {
    console.log("[7] forged signature correctly rejected");
  }

  // 7. Negative check: alg confusion (`none`) must be rejected.
  const noneTok =
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
    "." + p + ".";
  try {
    await jwtVerify(noneTok, jwks, { issuer, algorithms: ["RS256"] });
    console.log("[8] FAIL: alg=none ACCEPTED");
    process.exit(1);
  } catch {
    console.log("[8] alg=none correctly rejected");
  }

  console.log(`\nSUBJECT_FOR_TEST=${payload.sub}`);

  // 8. The real proof: does GOTCHA accept this token and resolve it to the
  // right account? This is the whole migration in one assertion.
  const apiBase = process.env.GOTCHA_API_URL;
  if (apiBase) {
    const me = await fetch(`${apiBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const body = await me.json();
    if (!me.ok) {
      console.error(`[9] GOTCHA REJECTED the token (${me.status}): ${JSON.stringify(body)}`);
      process.exit(1);
    }
    console.log(`[9] GOTCHA ACCEPTED the token`);
    console.log(`    user   = ${body.user.email} (${body.user.role})`);
    console.log(`    tenant = ${body.user.tenantId} [${body.tenantStatus}]`);
    if (body.user.email !== EMAIL) {
      console.error("[9] FAIL: token resolved to the WRONG account");
      process.exit(1);
    }
    if ("password" in body.user || "authentikSubject" in body.user) {
      console.error("[9] FAIL: /me leaked a credential/identity field");
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
