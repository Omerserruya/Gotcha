#!/usr/bin/env node
/**
 * MFA at login for the users GOTCHA requires it of - and only them (Option B,
 * Omer 2026-11-09). Authentik enforces per FLOW, so a flow-wide "configure"
 * would force every agent of every workspace to enrol. Instead the login flow
 * branches on the user attribute `gotcha_mfa_required`, which the auth service
 * keeps in step with mfaRequirementFor (services/auth mfa-required-flag):
 *
 *   order 30  default-authentication-mfa-validation   (skip, unchanged)
 *             bound behind policy gotcha-mfa-required, NEGATED: not required
 *             -> challenged if they have a device, never forced to enrol
 *   order 31  gotcha-required-mfa-validation           (configure: TOTP setup)
 *             behind gotcha-mfa-required: a required user without a device
 *             enrols TOTP inline; with one, is challenged (once - 30 is skipped)
 *   order 32  default-authenticator-static-setup       (recovery codes)
 *             behind gotcha-mfa-required-needs-recovery: required and no codes
 *
 * GOTCHA's own server gate (shared authenticate -> mfaServerGate) stays the
 * authority; this makes Authentik ask at login.
 *
 *   node required-mfa.mjs show      read only
 *   node required-mfa.mjs apply     idempotent
 *   node required-mfa.mjs rollback  removes 31, 32, the policies and the
 *                                   negated binding on 30 (back to stock skip)
 * Env: AUTHENTIK_URL, AUTHENTIK_BOOTSTRAP_TOKEN (or AUTHENTIK_API_TOKEN).
 */

const POLICY_REQUIRED = "gotcha-mfa-required";
const POLICY_NEEDS_RECOVERY = "gotcha-mfa-required-needs-recovery";
const STAGE_REQUIRED = "gotcha-required-mfa-validation";
const SHARED_VALIDATE = "default-authentication-mfa-validation";
const TOTP_SETUP = "default-authenticator-totp-setup";
const STATIC_SETUP = "default-authenticator-static-setup";
const AUTH_FLOW = "default-authentication-flow";

// The user being logged in is the flow plan's pending_user (as the stock
// default-authentication-flow policies read it), not request.user.
const USER = `flow_plan = request.context.get("flow_plan")
u = (flow_plan.context.get("pending_user") if flow_plan else None) or request.user
attrs = getattr(u, "attributes", None) or {}`;
const STOCK_VALIDATE_POLICY = "default-authentication-flow-authenticator-validate-stage";
const EXPR_REQUIRED = `${USER}
return bool(attrs.get("gotcha_mfa_required", False))`;
const EXPR_NEEDS_RECOVERY = `${USER}
return bool(attrs.get("gotcha_mfa_required", False)) and not ak_user_has_authenticator(u, "static")`;

export function client(base, token) {
  return async function api(path, options = {}) {
    const res = await fetch(`${base}/api/v3${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
    return body;
  };
}

async function stageByName(api, name) {
  const r = await api(`/stages/all/?page_size=200`);
  return r.results.find((s) => s.name === name) ?? null;
}
async function authFlow(api) {
  const f = (await api(`/flows/instances/?slug=${AUTH_FLOW}`)).results?.[0];
  if (!f) throw new Error(`${AUTH_FLOW} missing`);
  return f;
}
async function bindings(api, flowPk) {
  return (await api(`/flows/bindings/?target=${flowPk}&ordering=order&page_size=100`)).results;
}
async function policyByName(api, name) {
  return (await api(`/policies/expression/?name=${encodeURIComponent(name)}`)).results?.[0] ?? null;
}
/** A flow-stage binding is a policy target by its policybindingmodel_ptr_id, not its pk. */
const pbm = (binding) => binding.policybindingmodel_ptr_id ?? binding.pk;
async function policyBindingsOf(api, targetPk) {
  return (await api(`/policies/bindings/?target=${targetPk}&page_size=100`)).results;
}

async function upsertPolicy(api, name, expression) {
  const found = await policyByName(api, name);
  const body = JSON.stringify({ name, expression, execution_logging: false });
  return found
    ? api(`/policies/expression/${found.pk}/`, { method: "PATCH", body })
    : api(`/policies/expression/`, { method: "POST", body });
}

async function ensureFlowBinding(api, flowPk, stagePk, order) {
  const existing = (await bindings(api, flowPk)).find((b) => b.stage === stagePk);
  const body = { target: flowPk, stage: stagePk, order, evaluate_on_plan: false, re_evaluate_policies: true };
  return existing
    ? api(`/flows/bindings/${existing.pk}/`, { method: "PATCH", body: JSON.stringify(body) })
    : api(`/flows/bindings/`, { method: "POST", body: JSON.stringify(body) });
}

async function ensurePolicyBinding(api, targetPk, policyPk, negate) {
  const existing = (await policyBindingsOf(api, targetPk)).find((b) => b.policy === policyPk);
  const body = { target: targetPk, policy: policyPk, order: 0, negate, enabled: true, timeout: 30 };
  return existing
    ? api(`/policies/bindings/${existing.pk}/`, { method: "PATCH", body: JSON.stringify(body) })
    : api(`/policies/bindings/`, { method: "POST", body: JSON.stringify(body) });
}

export async function applyRequiredMfa(api, log = console.log) {
  const flow = await authFlow(api);
  const shared = await stageByName(api, SHARED_VALIDATE);
  const totp = await stageByName(api, TOTP_SETUP);
  const stat = await stageByName(api, STATIC_SETUP);
  if (!shared || !totp || !stat) throw new Error("stock MFA stages missing (validation / totp setup / static setup)");

  const pRequired = await upsertPolicy(api, POLICY_REQUIRED, EXPR_REQUIRED);
  const pRecovery = await upsertPolicy(api, POLICY_NEEDS_RECOVERY, EXPR_NEEDS_RECOVERY);

  // The required users' validation stage: configure, enrolling TOTP inline.
  const stageBody = {
    name: STAGE_REQUIRED,
    not_configured_action: "configure",
    device_classes: ["static", "totp", "webauthn"],
    configuration_stages: [totp.pk],
  };
  let required = (await api(`/stages/authenticator/validate/?name=${STAGE_REQUIRED}`)).results?.[0];
  required = required
    ? await api(`/stages/authenticator/validate/${required.pk}/`, { method: "PATCH", body: JSON.stringify(stageBody) })
    : await api(`/stages/authenticator/validate/`, { method: "POST", body: JSON.stringify(stageBody) });

  // The shared stage stays at skip; it now serves only the not-required.
  const sharedBinding = (await bindings(api, flow.pk)).find((b) => b.stage === shared.pk);
  if (!sharedBinding) throw new Error(`${SHARED_VALIDATE} is not bound to ${AUTH_FLOW}`);
  // "all": the stock rule (skip on passwordless passkey login) AND not required.
  await api(`/flows/bindings/${sharedBinding.pk}/`, { method: "PATCH", body: JSON.stringify({ evaluate_on_plan: false, re_evaluate_policies: true, policy_engine_mode: "all" }) });
  await ensurePolicyBinding(api, pbm(sharedBinding), pRequired.pk, true);

  const stock = await policyByName(api, STOCK_VALIDATE_POLICY);
  const b31 = await ensureFlowBinding(api, flow.pk, required.pk, sharedBinding.order + 1);
  await api(`/flows/bindings/${b31.pk}/`, { method: "PATCH", body: JSON.stringify({ policy_engine_mode: "all" }) });
  await ensurePolicyBinding(api, pbm(b31), pRequired.pk, false);
  if (stock) await ensurePolicyBinding(api, pbm(b31), stock.pk, false);
  const b32 = await ensureFlowBinding(api, flow.pk, stat.pk, sharedBinding.order + 2);
  await ensurePolicyBinding(api, pbm(b32), pRecovery.pk, false);
  log(`[required-mfa] applied: ${SHARED_VALIDATE} for the not-required (skip), ${STAGE_REQUIRED} (configure) + recovery-code setup for gotcha_mfa_required users`);
}

export async function rollbackRequiredMfa(api, log = console.log) {
  const flow = await authFlow(api);
  const shared = await stageByName(api, SHARED_VALIDATE);
  const stat = await stageByName(api, STATIC_SETUP);
  const required = await stageByName(api, STAGE_REQUIRED);
  const pRequired = await policyByName(api, POLICY_REQUIRED);
  const pRecovery = await policyByName(api, POLICY_NEEDS_RECOVERY);
  for (const b of await bindings(api, flow.pk)) {
    if ((required && b.stage === required.pk) || (stat && b.stage === stat.pk)) {
      await api(`/flows/bindings/${b.pk}/`, { method: "DELETE" });
    } else if (shared && b.stage === shared.pk) {
      if (pRequired) for (const pb of await policyBindingsOf(api, pbm(b))) if (pb.policy === pRequired.pk) await api(`/policies/bindings/${pb.pk}/`, { method: "DELETE" });
      await api(`/flows/bindings/${b.pk}/`, { method: "PATCH", body: JSON.stringify({ policy_engine_mode: "any" }) });
    }
  }
  if (required) await api(`/stages/authenticator/validate/${required.pk}/`, { method: "DELETE" });
  for (const p of [pRequired, pRecovery]) if (p) await api(`/policies/expression/${p.pk}/`, { method: "DELETE" });
  log(`[required-mfa] rolled back: ${AUTH_FLOW} is stock again (${SHARED_VALIDATE} skip for everyone)`);
}

export async function showRequiredMfa(api, log = console.log) {
  const flow = await authFlow(api);
  for (const b of await bindings(api, flow.pk)) {
    const pols = await policyBindingsOf(api, pbm(b));
    const names = [];
    for (const pb of pols) names.push(`${pb.negate ? "NOT " : ""}${pb.policy_obj?.name ?? pb.policy}`);
    log(`  ${b.order} ${b.stage_obj?.name} mode=${b.policy_engine_mode} plan=${b.evaluate_on_plan} re=${b.re_evaluate_policies}${names.length ? ` policies=[${names.join(", ")}]` : ""}`);
  }
  for (const s of (await api(`/stages/authenticator/validate/`)).results) log(`  VALIDATE ${s.name} ${s.not_configured_action} cfg=${JSON.stringify(s.configuration_stages)}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const base = process.env.AUTHENTIK_URL;
  const token = process.env.AUTHENTIK_BOOTSTRAP_TOKEN || process.env.AUTHENTIK_API_TOKEN;
  if (!base || !token) { console.error("AUTHENTIK_URL and AUTHENTIK_BOOTSTRAP_TOKEN are required"); process.exit(1); }
  const api = client(base.replace(/\/$/, ""), token);
  const mode = process.argv[2] ?? "show";
  const run = mode === "apply" ? applyRequiredMfa : mode === "rollback" ? rollbackRequiredMfa : showRequiredMfa;
  run(api).then(() => mode !== "show" && showRequiredMfa(api)).then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
}
