/**
 * Billing safety invariants.
 *
 * Each of these encodes a rule that must hold no matter what the iCount
 * integration ends up looking like. They are source-level assertions on
 * purpose: they have to keep failing loudly if a later round reintroduces the
 * behaviour, which a behavioural test on a route would not catch once the route
 * is rewritten.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

describe("adding a card provisions nothing", () => {
  const route = read("services/billing/src/routes/payment-methods.ts");

  it("does not start a trial as a side effect of storing a card", () => {
    expect(route).not.toContain("createTrialSubscription");
    expect(route).not.toContain("trialStarted");
  });

  it("returns no provisioning signal to the client", () => {
    // The response used to advertise `trialStarted`, which taught the frontend
    // that saving a card was a provisioning action.
    expect(route).toMatch(/res\.json\(\{\s*ok:\s*true,\s*paymentMethod:/);
  });
});

describe("the retired pro plan is not a fallback anywhere", () => {
  it("is not a default trial plan in code", () => {
    const route = read("services/billing/src/routes/payment-methods.ts");
    expect(route).not.toMatch(/\|\|\s*"pro"/);
  });

  it("has no BILLING_DEFAULT_TRIAL_PLAN consumer left", () => {
    // The variable existed solely to feed the auto-trial. With that gone, a
    // lingering default is a loaded gun pointing at a RETIRED, ILS-priced plan.
    for (const f of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      expect(read(f), `${f} must not set BILLING_DEFAULT_TRIAL_PLAN`).not.toContain(
        "BILLING_DEFAULT_TRIAL_PLAN",
      );
    }
    expect(read("services/billing/src/routes/payment-methods.ts")).not.toMatch(
      /process\.env\.BILLING_DEFAULT_TRIAL_PLAN/,
    );
  });
});

describe("no subscription activates from a browser redirect", () => {
  it("no route activates a subscription from a client-supplied success flag", () => {
    const route = read("services/billing/src/routes/payment-methods.ts");
    // A card-add response must never be a place that flips subscription state.
    // (Scoped to the subscription model - the route legitimately queries
    // payment methods by status: "ACTIVE".)
    expect(route).not.toContain("activateOrRenew");
    expect(route).not.toMatch(/prisma\.subscription\.(create|update|upsert)/);
  });
});

describe("live charging cannot happen by accident", () => {
  const provider = read("services/billing/src/providers/icount.provider.ts");

  it("guards every money-moving provider operation", () => {
    for (const op of ["tokenize", "charge", "refund"]) {
      expect(provider, `${op} must be behind assertLiveAllowed`).toContain(`assertLiveAllowed("${op}")`);
    }
  });

  it("requires production AND an explicit acknowledgement", () => {
    expect(provider).toContain('process.env.NODE_ENV === "production"');
    expect(provider).toContain('process.env.ICOUNT_ALLOW_LIVE === "true"');
  });
});

describe("the discovery tool cannot move money", () => {
  const tool = read("services/billing/src/scripts/icount-inspect.ts");

  it("allowlists only read-only actions", () => {
    expect(tool).toContain('const READ_ONLY_ACTIONS = ["auth/info", "paypage/info", "paypage/get_list"] as const');
  });

  it("calls no charge, refund, tokenization, document or mutation endpoint", () => {
    for (const forbidden of [
      "cc/charge", "cc/refund", "paypage/get_token_info", "token/create", "token/revoke",
      "doc/create", "doc/cancel", "paypage/create", "client/create",
    ]) {
      // Allowed to NAME them in the "deliberately excluded" comment, not to
      // call them: assert none appears as a quoted action argument.
      expect(tool, `must not call ${forbidden}`).not.toMatch(
        new RegExp(`readOnly\\(\\s*["']${forbidden.replace("/", "\\/")}["']`),
      );
    }
  });

  it("enforces the allowlist at call time, not just in types", () => {
    expect(tool).toContain("refusing non-allowlisted action");
  });

  it("never enables live charging", () => {
    expect(tool).not.toMatch(/ICOUNT_ALLOW_LIVE\s*=/);
    expect(tool).not.toMatch(/ICOUNT_MODE\s*=/);
  });

  it("is bounded: per-request timeout, run deadline, and no retries", () => {
    expect(tool).toContain("REQUEST_TIMEOUT_MS");
    expect(tool).toContain("RUN_DEADLINE_MS");
    expect(tool).toContain("deadlineExceeded()");
    // No retry mechanism: no axios-retry, no backoff loop, no attempt counter.
    // (The word "retry" appears in a comment explaining why there is none.)
    const code = tool.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/axios-?retry|backoff|attempt\s*[<>+]|while\s*\(/i);
  });

  it("cannot issue an unauthenticated request", () => {
    // authHeaders() throws when no token is configured.
    expect(tool).toContain("headers: authHeaders()");
  });

  it("redacts secrets on every output path, including fatal errors", () => {
    expect(tool).toContain("redactIcount");
    expect(tool).toMatch(/fatal[\s\S]{0,120}redactIcount/);
  });

  it("is never imported by the running service", () => {
    const index = read("services/billing/src/index.ts");
    expect(index).not.toContain("icount-inspect");
  });
});
