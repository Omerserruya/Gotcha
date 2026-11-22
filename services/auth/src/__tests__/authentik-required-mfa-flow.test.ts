/**
 * Required two-step on a sign-in flow other than the default one (2026-11-22).
 *
 * scripts/authentik/required-mfa.mjs made Authentik ask a person whose
 * workspace requires two-step, but only on default-authentication-flow. A
 * sign-in through an outside source (Google) runs the source's own flow, which
 * stock has one stage: the login. With a flow named, the script puts the same
 * three stages before that flow's login.
 *
 * What is under test is what a person MEETS on each flow, worked out the way
 * Authentik does (stages in order, each behind its bound policies), on a double
 * of Authentik's API that keeps Authentik's own rules: a deleted policy takes
 * its bindings with it, a deleted stage or flow binding takes what hangs on it,
 * and one flow cannot hold a stage twice on one order.
 *
 * Not seen live yet (the dev walk): that Authentik accepts a negative order.
 * Its model is a plain IntegerField, read from its source.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/authentik/required-mfa.mjs");
const script = async (): Promise<any> => import(/* @vite-ignore */ pathToFileURL(SCRIPT).href);

// ── Authentik, in memory ────────────────────────────────────────────────────

interface Flow { pk: string; slug: string; designation: string }
interface Stage { pk: string; name: string; meta_model_name: string; [k: string]: unknown }
interface FlowBinding { pk: string; policybindingmodel_ptr_id: string; target: string; stage: string; order: number; evaluate_on_plan: boolean; re_evaluate_policies: boolean; policy_engine_mode: string }
interface Policy { pk: string; name: string; expression: string }
interface PolicyBinding { pk: string; target: string; policy: string; negate: boolean; order: number; enabled: boolean; timeout: number }

const VALIDATE = "authentik_stages_authenticator_validate.authenticatorvalidatestage";
const LOGIN = "authentik_stages_user_login.userloginstage";

const A = {
  flows: [] as Flow[],
  stages: [] as Stage[],
  fbs: [] as FlowBinding[],
  policies: [] as Policy[],
  pbs: [] as PolicyBinding[],
  seq: 0,
  writes: [] as string[],
  /** Authentik ignoring a filter it does not know answers with everything. */
  ignoreFlowSlugFilter: false,
};
const id = (p: string) => `${p}-${++A.seq}`;
const fail = (method: string, p: string, status: number, body: unknown): never => {
  throw new Error(`${method} ${p} -> ${status}: ${JSON.stringify(body)}`);
};
const page = (results: unknown[]) => ({ pagination: { next: 0 }, results });

function dropFlowBinding(pk: string) {
  const b = A.fbs.find((x) => x.pk === pk);
  if (!b) return;
  A.fbs = A.fbs.filter((x) => x.pk !== pk);
  A.pbs = A.pbs.filter((x) => x.target !== b.policybindingmodel_ptr_id);
}

async function api(p: string, options: any = {}): Promise<any> {
  const method = String(options.method || "GET").toUpperCase();
  const url = new URL(`http://authentik${p}`);
  const q = url.searchParams;
  const body = options.body ? JSON.parse(options.body) : null;
  if (method !== "GET") A.writes.push(`${method} ${url.pathname}`);
  const one = (re: RegExp) => re.exec(url.pathname)?.[1];

  if (url.pathname === "/flows/instances/" && method === "GET") {
    const slug = q.get("slug");
    return page(A.flows.filter((f) => A.ignoreFlowSlugFilter || !slug || f.slug === slug));
  }
  if (url.pathname === "/stages/all/" && method === "GET") return page(A.stages);

  if (url.pathname === "/flows/bindings/") {
    if (method === "GET") {
      const rows = A.fbs
        .filter((b) => (!q.get("target") || b.target === q.get("target")) && (!q.get("stage") || b.stage === q.get("stage")))
        .sort((x, y) => x.order - y.order)
        .map((b) => ({ ...b, stage_obj: A.stages.find((s) => s.pk === b.stage) }));
      return page(rows);
    }
    if (method === "POST") {
      if (!Number.isInteger(body.order)) fail(method, p, 400, { order: ["A valid integer is required."] });
      if (!body.evaluate_on_plan && !body.re_evaluate_policies) fail(method, p, 400, { non_field_errors: ["Either evaluation on plan or evaluation on run must be enabled"] });
      if (A.fbs.some((b) => b.target === body.target && b.stage === body.stage && b.order === body.order)) fail(method, p, 400, { non_field_errors: ["unique set"] });
      const row: FlowBinding = { pk: id("fb"), policybindingmodel_ptr_id: id("pbm"), policy_engine_mode: "any", ...body };
      A.fbs.push(row);
      return { ...row };
    }
  }
  const fb = one(/^\/flows\/bindings\/([^/]+)\/$/);
  if (fb) {
    const row = A.fbs.find((b) => b.pk === fb) ?? fail(method, p, 404, { detail: "Not found." });
    if (method === "PATCH") { Object.assign(row, body); return { ...row }; }
    if (method === "DELETE") { dropFlowBinding(fb); return null; }
  }

  if (url.pathname === "/policies/expression/") {
    if (method === "GET") return page(A.policies.filter((x) => !q.get("name") || x.name === q.get("name")));
    if (method === "POST") { const row = { pk: id("pol"), ...body }; A.policies.push(row); return { ...row }; }
  }
  const pol = one(/^\/policies\/expression\/([^/]+)\/$/);
  if (pol) {
    const row = A.policies.find((x) => x.pk === pol) ?? fail(method, p, 404, { detail: "Not found." });
    if (method === "PATCH") { Object.assign(row, body); return { ...row }; }
    if (method === "DELETE") {
      A.policies = A.policies.filter((x) => x.pk !== pol);
      A.pbs = A.pbs.filter((x) => x.policy !== pol);   // Authentik: the bindings go with the policy
      return null;
    }
  }

  if (url.pathname === "/policies/bindings/") {
    if (method === "GET") {
      return page(A.pbs
        .filter((b) => (!q.get("target") || b.target === q.get("target")) && (!q.get("policy") || b.policy === q.get("policy")))
        .map((b) => ({ ...b, policy_obj: A.policies.find((x) => x.pk === b.policy) })));
    }
    if (method === "POST") { const row = { pk: id("pb"), ...body }; A.pbs.push(row); return { ...row }; }
  }
  const pb = one(/^\/policies\/bindings\/([^/]+)\/$/);
  if (pb) {
    const row = A.pbs.find((b) => b.pk === pb) ?? fail(method, p, 404, { detail: "Not found." });
    if (method === "PATCH") { Object.assign(row, body); return { ...row }; }
    if (method === "DELETE") { A.pbs = A.pbs.filter((b) => b.pk !== pb); return null; }
  }

  if (url.pathname === "/stages/authenticator/validate/") {
    const mine = A.stages.filter((s) => s.meta_model_name === VALIDATE);
    if (method === "GET") return page(mine.filter((s) => !q.get("name") || s.name === q.get("name")));
    if (method === "POST") { const row = { pk: id("stage"), meta_model_name: VALIDATE, ...body }; A.stages.push(row); return { ...row }; }
  }
  const st = one(/^\/stages\/authenticator\/validate\/([^/]+)\/$/);
  if (st) {
    const row = A.stages.find((s) => s.pk === st) ?? fail(method, p, 404, { detail: "Not found." });
    if (method === "PATCH") { Object.assign(row, body); return { ...row }; }
    if (method === "DELETE") {
      for (const b of A.fbs.filter((x) => x.stage === st)) dropFlowBinding(b.pk);
      A.stages = A.stages.filter((s) => s.pk !== st);
      return null;
    }
  }
  return fail(method, p, 404, { detail: "no such route in the double" });
}

// ── Stock Authentik ─────────────────────────────────────────────────────────

const DEFAULT = "default-authentication-flow";
const SOURCE = "default-source-authentication";
const STOCK_POLICY = "default-authentication-flow-authenticator-validate-stage";

function stage(name: string, model: string, extra: Record<string, unknown> = {}): Stage {
  const row = { pk: id("stage"), name, meta_model_name: model, ...extra };
  A.stages.push(row);
  return row;
}
function flow(slug: string, designation: string): Flow {
  const row = { pk: id("flow"), slug, designation };
  A.flows.push(row);
  return row;
}
function bind(f: Flow, s: Stage, order: number): FlowBinding {
  const row = { pk: id("fb"), policybindingmodel_ptr_id: id("pbm"), target: f.pk, stage: s.pk, order, evaluate_on_plan: true, re_evaluate_policies: false, policy_engine_mode: "any" };
  A.fbs.push(row);
  return row;
}

beforeEach(() => {
  A.flows = []; A.stages = []; A.fbs = []; A.policies = []; A.pbs = []; A.seq = 0; A.writes = []; A.ignoreFlowSlugFilter = false;
  const def = flow(DEFAULT, "authentication");
  const src = flow(SOURCE, "authentication");
  const rec = flow("default-recovery-flow", "recovery");
  const bare = flow("an-auth-flow-with-no-login", "authentication");
  const ident = stage("default-authentication-identification", "authentik_stages_identification.identificationstage");
  const pass = stage("default-authentication-password", "authentik_stages_password.passwordstage");
  const validate = stage("default-authentication-mfa-validation", VALIDATE, { not_configured_action: "skip" });
  const login = stage("default-authentication-login", LOGIN);
  const srcLogin = stage("default-source-authentication-login", LOGIN);
  const recLogin = stage("default-recovery-user-login", LOGIN);
  stage("default-authenticator-totp-setup", "authentik_stages_authenticator_totp.authenticatortotpstage");
  stage("default-authenticator-static-setup", "authentik_stages_authenticator_static.authenticatorstaticstage");
  bind(def, ident, 10); bind(def, pass, 20);
  const v = bind(def, validate, 30);
  bind(def, login, 100);
  bind(src, srcLogin, 0);
  bind(rec, recLogin, 100);
  bind(bare, ident, 10);
  const stock = { pk: id("pol"), name: STOCK_POLICY, expression: "return True" };
  A.policies.push(stock);
  A.pbs.push({ pk: id("pb"), target: v.policybindingmodel_ptr_id, policy: stock.pk, negate: false, order: 0, enabled: true, timeout: 30 });
  A.seq = 1000;
});

// ── What a person meets ─────────────────────────────────────────────────────

interface Person { required: boolean; codes: boolean }
const NOT_REQUIRED: Person = { required: false, codes: false };
const REQUIRED_NEW: Person = { required: true, codes: false };
const REQUIRED_SET_UP: Person = { required: true, codes: true };

/** The stages a person reaches on a flow, in order: a stage runs when its bound policies let it. */
function meets(slug: string, who: Person): string[] {
  const f = A.flows.find((x) => x.slug === slug)!;
  const passes = (name: string) =>
    name === "gotcha-mfa-required" ? who.required
      : name === "gotcha-mfa-required-needs-recovery" ? who.required && !who.codes
        : true;
  return A.fbs.filter((b) => b.target === f.pk).sort((x, y) => x.order - y.order).filter((b) => {
    const bound = A.pbs.filter((x) => x.target === b.policybindingmodel_ptr_id && x.enabled);
    if (!bound.length) return true;
    const results = bound.map((x) => passes(A.policies.find((pl) => pl.pk === x.policy)!.name) !== x.negate);
    return b.policy_engine_mode === "all" ? results.every(Boolean) : results.some(Boolean);
  }).map((b) => A.stages.find((s) => s.pk === b.stage)!.name);
}
/** A flow's bindings as an operator would read them. */
function laidOut(slug: string): string[] {
  const f = A.flows.find((x) => x.slug === slug)!;
  return A.fbs.filter((b) => b.target === f.pk).sort((x, y) => x.order - y.order).map((b) => {
    const pols = A.pbs.filter((x) => x.target === b.policybindingmodel_ptr_id)
      .map((x) => `${x.negate ? "NOT " : ""}${A.policies.find((pl) => pl.pk === x.policy)!.name}`).sort();
    return `${b.order} ${A.stages.find((s) => s.pk === b.stage)!.name}${pols.length ? ` [${pols.join(", ")}]` : ""}`;
  });
}
const snapshot = () => JSON.stringify({ flows: A.flows, stages: A.stages, fbs: A.fbs, policies: A.policies, pbs: A.pbs });
const quiet = () => {};

const SHARED = "default-authentication-mfa-validation";
const REQ = "gotcha-required-mfa-validation";
const CODES = "default-authenticator-static-setup";
const SRC_LOGIN = "default-source-authentication-login";

describe("stock Authentik: the hole this closes", () => {
  it("on the source's flow a person required to use two-step meets the login and nothing else", () => {
    expect(meets(SOURCE, REQUIRED_NEW)).toEqual([SRC_LOGIN]);
  });

  it("the default flow's rule, applied with no flow named, does not reach the source's flow", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    expect(meets(SOURCE, REQUIRED_NEW)).toEqual([SRC_LOGIN]);
    expect(laidOut(SOURCE)).toEqual([`0 ${SRC_LOGIN}`]);
  });
});

describe("apply with a flow named", () => {
  it("the three stages sit on the three orders just before that flow's login, behind the same policies", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(SOURCE)).toEqual([
      `-3 ${SHARED} [NOT gotcha-mfa-required]`,
      `-2 ${REQ} [gotcha-mfa-required]`,
      `-1 ${CODES} [gotcha-mfa-required-needs-recovery]`,
      `0 ${SRC_LOGIN}`,
    ]);
  });

  it.each([
    ["not required: the skip stage (asked only if they have a device), then the login", NOT_REQUIRED, [SHARED, SRC_LOGIN]],
    ["required, no recovery codes yet: the enrolling stage, the codes, then the login", REQUIRED_NEW, [REQ, CODES, SRC_LOGIN]],
    ["required, already set up: the enrolling stage challenges once, then the login", REQUIRED_SET_UP, [REQ, SRC_LOGIN]],
  ])("%s", async (_name, who, expected) => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(meets(SOURCE, who)).toEqual(expected);
  });

  it("a required person never reaches the login without passing the enrolling stage first", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    for (const who of [REQUIRED_NEW, REQUIRED_SET_UP]) {
      const seen = meets(SOURCE, who);
      expect(seen.indexOf(REQ)).toBeGreaterThanOrEqual(0);
      expect(seen.indexOf(REQ)).toBeLessThan(seen.indexOf(SRC_LOGIN));
    }
  });

  it("each new binding is evaluated when its turn comes, not when the flow is planned", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    const src = A.flows.find((f) => f.slug === SOURCE)!;
    for (const b of A.fbs.filter((x) => x.target === src.pk && x.order < 0)) {
      expect(b).toMatchObject({ evaluate_on_plan: false, re_evaluate_policies: true });
    }
  });

  it("the login is found by what it is, wherever it sits: at 10 the three take 7, 8, 9", async () => {
    const src = A.flows.find((f) => f.slug === SOURCE)!;
    A.fbs.find((b) => b.target === src.pk)!.order = 10;
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(SOURCE).map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([`7 ${SHARED}`, `8 ${REQ}`, `9 ${CODES}`, `10 ${SRC_LOGIN}`]);
  });

  it("the default flow is not touched", async () => {
    const before = laidOut(DEFAULT);
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(DEFAULT)).toEqual(before);
    expect(meets(DEFAULT, REQUIRED_NEW)).not.toContain(REQ);
  });

  it("the default flow already applied: it stays exactly as it was, and the stage and policies are reused, not doubled", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    const before = laidOut(DEFAULT);
    const counts = { stages: A.stages.length, policies: A.policies.length };
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(DEFAULT)).toEqual(before);
    expect({ stages: A.stages.length, policies: A.policies.length }).toEqual(counts);
  });

  it("the source's flow first, the default flow after: one stage and one pair of policies serve both", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    await applyRequiredMfa(api, quiet);
    expect(A.stages.filter((s) => s.name === REQ)).toHaveLength(1);
    expect(A.policies.map((p) => p.name).sort()).toEqual([STOCK_POLICY, "gotcha-mfa-required", "gotcha-mfa-required-needs-recovery"]);
    expect(meets(SOURCE, REQUIRED_NEW)).toEqual([REQ, CODES, SRC_LOGIN]);
    expect(meets(DEFAULT, REQUIRED_NEW)).toContain(REQ);
  });

  it("twice is once: the second run adds no row and changes nothing", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    const once = snapshot();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(snapshot()).toBe(once);
  });

  it("says which flow it was applied on", async () => {
    const lines: string[] = [];
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, (m: string) => lines.push(m), SOURCE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`applied on ${SOURCE}`);
  });
});

describe("apply with a flow named: refused before anything is written", () => {
  it.each([
    ["a flow that does not exist", "default-source-authentification", /default-source-authentification missing/],
    ["a flow that is not a sign-in flow", "default-recovery-flow", /is a recovery flow, not a sign-in flow/],
    ["a sign-in flow with no login stage", "an-auth-flow-with-no-login", /has no login stage/],
  ])("%s", async (_name, slug, message) => {
    const before = snapshot();
    const { applyRequiredMfa } = await script();
    await expect(applyRequiredMfa(api, quiet, slug)).rejects.toThrow(message);
    expect(A.writes).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("a slug filter Authentik ignored does not hand the rule to some other flow", async () => {
    A.ignoreFlowSlugFilter = true;
    const { applyRequiredMfa } = await script();
    await expect(applyRequiredMfa(api, quiet, "no-such-flow")).rejects.toThrow(/no-such-flow missing/);
    expect(A.writes).toEqual([]);
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(meets(SOURCE, REQUIRED_NEW)).toEqual([REQ, CODES, SRC_LOGIN]);
    expect(laidOut("default-recovery-flow")).toEqual(["100 default-recovery-user-login"]);
  });
});

describe("apply with no flow named is what it always was", () => {
  const APPLIED = [
    "10 default-authentication-identification",
    "20 default-authentication-password",
    `30 ${SHARED} [NOT gotcha-mfa-required, ${STOCK_POLICY}]`,
    `31 ${REQ} [${STOCK_POLICY}, gotcha-mfa-required]`,
    `32 ${CODES} [gotcha-mfa-required-needs-recovery]`,
    "100 default-authentication-login",
  ];

  it("the default flow: 30 for the not required, 31 and 32 for the required", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    expect(laidOut(DEFAULT)).toEqual(APPLIED);
    expect(meets(DEFAULT, NOT_REQUIRED)).toEqual(["default-authentication-identification", "default-authentication-password", SHARED, "default-authentication-login"]);
    expect(meets(DEFAULT, REQUIRED_NEW)).toEqual(["default-authentication-identification", "default-authentication-password", REQ, CODES, "default-authentication-login"]);
  });

  it("naming the default flow is the same as naming none", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, DEFAULT);
    expect(laidOut(DEFAULT)).toEqual(APPLIED);
    expect(laidOut(SOURCE)).toEqual([`0 ${SRC_LOGIN}`]);
  });

  it("the two-argument call bootstrap makes still works", async () => {
    const lines: string[] = [];
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, (m: string) => lines.push(m));
    expect(lines).toEqual([expect.stringContaining("[required-mfa] applied: ")]);
  });
});

describe("rollback with a flow named", () => {
  it("that flow's three bindings go and its login stays", async () => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await applyRequiredMfa(api, quiet, SOURCE);
    await rollbackRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(SOURCE)).toEqual([`0 ${SRC_LOGIN}`]);
    expect(A.pbs.filter((x) => !A.fbs.some((b) => b.policybindingmodel_ptr_id === x.target))).toEqual([]);
  });

  it("the default flow keeps asking: the stage and the policies it shares are not deleted", async () => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await applyRequiredMfa(api, quiet, SOURCE);
    const before = laidOut(DEFAULT);
    await rollbackRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(DEFAULT)).toEqual(before);
    expect(meets(DEFAULT, REQUIRED_NEW)).toEqual(["default-authentication-identification", "default-authentication-password", REQ, CODES, "default-authentication-login"]);
    expect(A.stages.some((s) => s.name === REQ)).toBe(true);
    expect(A.policies.map((p) => p.name)).toEqual(expect.arrayContaining(["gotcha-mfa-required", "gotcha-mfa-required-needs-recovery"]));
    expect(A.writes.filter((w) => w.startsWith("DELETE /policies/") || w.startsWith("DELETE /stages/"))).toEqual([]);
  });

  it("nothing applied there: nothing removed, no error, and it says so", async () => {
    const before = snapshot();
    const lines: string[] = [];
    const { rollbackRequiredMfa } = await script();
    await rollbackRequiredMfa(api, (m: string) => lines.push(m), SOURCE);
    expect(snapshot()).toBe(before);
    expect(lines[0]).toContain(`rolled back on ${SOURCE}: 0 stage binding(s) removed`);
  });

  it("apply, rollback, apply again lands where the first apply did", async () => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    const first = laidOut(SOURCE);
    await rollbackRequiredMfa(api, quiet, SOURCE);
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(laidOut(SOURCE)).toEqual(first);
  });

  it("a flow that does not exist is refused, nothing written", async () => {
    const { rollbackRequiredMfa } = await script();
    await expect(rollbackRequiredMfa(api, quiet, "nope")).rejects.toThrow(/nope missing/);
    expect(A.writes).toEqual([]);
  });
});

describe("rollback of the default flow while another flow still uses the rule", () => {
  it("refused, naming the flow, with nothing changed", async () => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await applyRequiredMfa(api, quiet, SOURCE);
    const before = snapshot();
    A.writes = [];
    await expect(rollbackRequiredMfa(api, quiet)).rejects.toThrow(new RegExp(`still bound on ${SOURCE}.*Nothing was changed`));
    expect(A.writes).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("why: with the policies deleted, everyone on the other flow would be made to set up recovery codes", async () => {
    const { applyRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    expect(meets(SOURCE, NOT_REQUIRED)).not.toContain(CODES);
    // What the refusal prevents, done by hand on the double:
    for (const pol of A.policies.filter((x) => x.name.startsWith("gotcha-mfa-required"))) {
      await api(`/policies/expression/${pol.pk}/`, { method: "DELETE" });
    }
    expect(meets(SOURCE, NOT_REQUIRED)).toContain(CODES);
  });

  it.each([[SHARED], [REQ], [CODES]])("one binding left on the other flow (%s) is enough to refuse", async (left) => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await applyRequiredMfa(api, quiet, SOURCE);
    const src = A.flows.find((f) => f.slug === SOURCE)!;
    const keep = A.stages.find((s) => s.name === left)!;
    for (const b of A.fbs.filter((x) => x.target === src.pk && x.order < 0 && x.stage !== keep.pk)) dropFlowBinding(b.pk);
    A.writes = [];
    await expect(rollbackRequiredMfa(api, quiet)).rejects.toThrow(new RegExp(`still bound on ${SOURCE}`));
    expect(A.writes).toEqual([]);
  });

  it("a use of the policy it cannot put a flow name to is still a refusal", async () => {
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    // Bound by hand to a stage this script does not know, on another flow.
    const rec = A.flows.find((f) => f.slug === "default-recovery-flow")!;
    const target = A.fbs.find((x) => x.target === rec.pk)!.policybindingmodel_ptr_id;
    const pol = A.policies.find((x) => x.name === "gotcha-mfa-required")!;
    A.pbs.push({ pk: "pb-hand", target, policy: pol.pk, negate: false, order: 0, enabled: true, timeout: 30 });
    A.writes = [];
    await expect(rollbackRequiredMfa(api, quiet)).rejects.toThrow(/still bound on another flow/);
    expect(A.writes).toEqual([]);
  });

  it("the other flow rolled back first: the default flow's rollback goes through, back to stock", async () => {
    const stock = laidOut(DEFAULT);
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await applyRequiredMfa(api, quiet, SOURCE);
    await rollbackRequiredMfa(api, quiet, SOURCE);
    await rollbackRequiredMfa(api, quiet);
    expect(laidOut(DEFAULT)).toEqual(stock);
    expect(laidOut(SOURCE)).toEqual([`0 ${SRC_LOGIN}`]);
    expect(A.stages.some((s) => s.name === REQ)).toBe(false);
    expect(A.policies.map((p) => p.name)).toEqual([STOCK_POLICY]);
  });

  it("no other flow ever used it: the default flow's rollback is what it always was", async () => {
    const stock = laidOut(DEFAULT);
    const { applyRequiredMfa, rollbackRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet);
    await rollbackRequiredMfa(api, quiet);
    expect(laidOut(DEFAULT)).toEqual(stock);
    expect(A.policies.map((p) => p.name)).toEqual([STOCK_POLICY]);
  });

  it("never applied anywhere: the default flow's rollback still does nothing and does not fail", async () => {
    const stock = laidOut(DEFAULT);
    const { rollbackRequiredMfa } = await script();
    await rollbackRequiredMfa(api, quiet);
    expect(laidOut(DEFAULT)).toEqual(stock);
  });
});

describe("show", () => {
  it("with a flow named, shows that flow; with none, the default one", async () => {
    const { applyRequiredMfa, showRequiredMfa } = await script();
    await applyRequiredMfa(api, quiet, SOURCE);
    const named: string[] = [];
    await showRequiredMfa(api, (m: string) => named.push(m), SOURCE);
    expect(named[0]).toBe(`  FLOW ${SOURCE}`);
    expect(named.join("\n")).toContain(`-2 ${REQ}`);
    expect(named.join("\n")).not.toContain("default-authentication-password");
    const plain: string[] = [];
    await showRequiredMfa(api, (m: string) => plain.push(m));
    expect(plain[0]).toBe(`  FLOW ${DEFAULT}`);
    expect(plain.join("\n")).toContain("default-authentication-password");
  });

  it("writes nothing", async () => {
    const { showRequiredMfa } = await script();
    await showRequiredMfa(api, quiet, SOURCE);
    expect(A.writes).toEqual([]);
  });
});
