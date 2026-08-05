#!/usr/bin/env node
/**
 * Regression guard for the Authentik flow configuration GOTCHA depends on.
 *
 * Asserts the invariants whose violation produced the two 2026-07-19
 * "Request has been denied" incidents (identity-operations-guide.md §17):
 *
 *   1. gotcha-recovery / gotcha-recovery-self have authentication="none"
 *      (require_unauthenticated denies + BURNS invite links opened in a
 *      browser holding any Authentik session).
 *   2. The password-strength policy is attached to the password prompt
 *      STAGE's validation_policies, and is NOT bound to any flow-stage
 *      binding (a flow binding evaluates at plan time, silently drops the
 *      prompt stage from every minted recovery link -> "No Pending data.").
 *   3. Functionally: a freshly minted recovery link, opened unauthenticated,
 *      yields a PROMPT challenge (the "Set your password" form), not an
 *      access-denied challenge. This exercises the same executor path the
 *      invite email hits.
 *
 * Run inside the repo with the dev stack up:
 *   node scripts/authentik/verify-flows.mjs
 * Uses AUTHENTIK_PUBLIC_API (default http://localhost:9000) and the bootstrap
 * token from env AUTHENTIK_BOOTSTRAP_TOKEN or ./.env.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.AUTHENTIK_PUBLIC_API || "http://localhost:9000";
const TOKEN =
  process.env.AUTHENTIK_BOOTSTRAP_TOKEN ||
  (() => {
    try {
      const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
      return /AUTHENTIK_BOOTSTRAP_TOKEN=(.+)/.exec(env)?.[1]?.trim();
    } catch {
      return undefined;
    }
  })();
if (!TOKEN) {
  console.error("AUTHENTIK_BOOTSTRAP_TOKEN not found (env or .env)");
  process.exit(2);
}

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ── 1. recovery flows must not gate on session state ────────────────────────
for (const slug of ["gotcha-recovery", "gotcha-recovery-self"]) {
  const flow = await api(`/flows/instances/${slug}/`);
  check(
    `flow ${slug} authentication="none"`,
    flow.authentication === "none",
    `got "${flow.authentication}"`,
  );
}

// ── 2. password policy wired to prompt-stage validation, not flow binding ───
const policy = (await api(`/policies/password/?name=gotcha-password-strength`)).results[0];
check("gotcha-password-strength policy exists", !!policy);
if (policy) {
  const prompt = (await api(`/stages/prompt/stages/?name=default-password-change-prompt`)).results[0];
  check(
    "policy in prompt stage validation_policies",
    (prompt?.validation_policies || []).includes(policy.pk),
  );
  const bindings = await api(`/policies/bindings/?policy=${policy.pk}`);
  check(
    "policy has NO flow/stage bindings (plan-time trap)",
    bindings.pagination.count === 0,
    `found ${bindings.pagination.count}`,
  );
}

// ── 3. functional: minted recovery link renders the password prompt ─────────
// Temp identity -> mint link -> hit the flow executor UNAUTHENTICATED with a
// session jar -> assert the first challenge is the prompt, not access-denied.
const probe = await api(`/core/users/`, {
  method: "POST",
  body: JSON.stringify({
    username: "flow-verify-probe@test.local",
    email: "flow-verify-probe@test.local",
    name: "Flow Verify Probe",
    path: "users",
    type: "external",
  }),
}).catch(async () => {
  // Leftover from an aborted run - reuse it.
  const existing = await api(`/core/users/?username=flow-verify-probe@test.local`);
  return existing.results[0];
});
try {
  const { link } = await api(`/core/users/${probe.pk}/recovery/`, { method: "POST" });
  const token = new URL(link).searchParams.get("flow_token");
  check("recovery link carries flow_token", !!token);

  // The browser SPA calls the executor with the original query string wrapped
  // in ?query=. Cookies must persist across the redirect-free JSON exchange.
  let cookies = "";
  const exec = await fetch(
    `${BASE}/api/v3/flows/executor/gotcha-recovery/?query=${encodeURIComponent(`flow_token=${token}`)}`,
    { headers: { Cookie: cookies } },
  );
  (exec.headers.getSetCookie?.() || []).forEach((c) => (cookies += c.split(";")[0] + "; "));
  const challenge = await exec.json();
  check(
    "recovery executor returns prompt challenge (not access-denied)",
    challenge.component === "ak-stage-prompt",
    `component=${challenge.component}${challenge.error_message ? `, error="${challenge.error_message}"` : ""}`,
  );
} finally {
  await api(`/core/users/${probe.pk}/`, { method: "DELETE" }).catch(() => {});
}

if (failures.length) {
  console.error(`\n${failures.length} invariant(s) violated.`);
  process.exit(1);
}
console.log("\nAll Authentik flow invariants hold.");
