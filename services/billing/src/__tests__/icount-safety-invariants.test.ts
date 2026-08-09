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
    // that saving a card was a provisioning action. It now returns the stored
    // card and nothing else - notably no subscription, plan or trial.
    expect(route).toContain('status: "STORED"');
    for (const signal of ["trialStarted", "subscription:", "planKey:", "trialEndsAt"]) {
      expect(route, `the response must not carry ${signal}`).not.toContain(signal);
    }
  });

  it("never takes the stored card from the client", () => {
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The browser sends a session id; what was stored is established by asking
    // the provider. It used to send the token itself, which is the same mistake
    // as trusting a redirect.
    expect(code).not.toContain("req.body?.pageToken");
    expect(code).not.toMatch(/body\??\.(token|ccToken|cardToken)/);
    expect(code).toContain("verifyTokenizationSession");
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

describe("the provider uses only iCount-verified operations", () => {
  const provider = read("services/billing/src/providers/icount.provider.ts");
  // The wire-level calls moved into a typed client, so the payload assertions
  // follow them. What is asserted is unchanged: only confirmed operations, only
  // confirmed fields.
  const client = read("services/billing/src/providers/icount-client.ts");

  it("calls the verified endpoints", () => {
    for (const op of ["cc/bill", "doc/cancel", "cc/transactions", "paypage/generate_sale", "client/get_cc_tokens"]) {
      // Tolerant of the call being wrapped across lines; strict about the
      // action name being a literal argument to call().
      const pattern = new RegExp(`call(<[^>]*>)?\\(\\s*\n?\\s*"${op.replace("/", "\\/")}"`);
      expect(client, `${op} must be called through the typed client`).toMatch(pattern);
    }
  });

  it("no longer calls the fabricated endpoints", () => {
    for (const invented of ["cc/charge", "cc/refund", "paypage/get_token_info"]) {
      const pattern = new RegExp(`call\\(\\s*["']${invented.replace("/", "\\/")}["']`);
      expect(client, `must not call ${invented}`).not.toMatch(pattern);
      expect(provider, `must not call ${invented}`).not.toMatch(pattern);
    }
  });

  it("sends only the fields iCount confirmed for cc/bill", () => {
    // Comments are stripped before slicing. The window used to be measured
    // against raw source, so explaining a field in a comment above it could
    // push the field itself out of view and fail a request that was correct.
    const bare = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Anchor on the CALL, not on the first mention of the path - the guards at
    // the top of bill() name "cc/bill" too, and matching those slices the
    // request body out of the window entirely.
    const at = bare.search(/call\(\s*\n?\s*"cc\/bill"/);
    expect(at, "cc/bill must be dispatched through call()").toBeGreaterThan(-1);
    const body = bare.slice(at, at + 500);
    expect(body).toContain("sum:");
    // `cc_token_id`, the API's own name for a stored card. Not `token`, which
    // cc/bill does not define and which therefore identified nothing.
    expect(body).toContain("cc_token_id:");
    expect(body).not.toMatch(/^\s*token:/m);
    expect(body).toContain("client_id:");
    // currency_id IS confirmed (1 = ILS). The rest remain invented.
    expect(body).toContain("currency_id:");
    expect(body).not.toMatch(/currency_code:|idempotency_key:|description:/);
  });

  it("refuses any charge that is not ILS with currency_id 1", () => {
    expect(provider).toContain("assertChargeSafety");
    expect(provider).toMatch(/only ILS charges are enabled/);
    // The account is multi-currency, so a wrong id does not fail - it charges
    // the wrong amount.
    expect(provider).toMatch(/CURRENCY_ID_ILS/);
  });

  it("establishes tokenization server-side rather than from a redirect", () => {
    // The token-retrieval contract is now verified, so checkout is enabled -
    // but the success signal must still be a provider query.
    expect(provider).toContain("listStoredCards");
    expect(client).toContain('call("client/get_cc_tokens"');
    expect(provider).toMatch(/tokenizeAndVerify is not the tokenization path/);
  });

  it("never treats an unknown outcome as a failure that may be retried", () => {
    // A decline means no money moved. An unknown means it may have. Collapsing
    // the two is how a customer gets billed twice.
    expect(client).toContain("IcountOutcomeUnknown");
    expect(client).toMatch(/mutating[\s\S]{0,400}IcountOutcomeUnknown/);
    expect(provider).toMatch(/if \(err instanceof IcountOutcomeUnknown\) throw err/);
  });

  it("reports a reference-less success as needing reconciliation, not success", () => {
    // Without a reference the charge cannot be reconciled or refunded, and an
    // invented id would hide that.
    expect(provider).toContain("charge_reference_missing");
    expect(provider).toContain("requiresReconciliation: true");
  });

  it("refuses a partial refund rather than cancelling the whole document", () => {
    expect(provider).toContain("partial_refund_unsupported");
  });

  it("refuses a refund with no document reference", () => {
    expect(provider).toContain("missing_document_reference");
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

describe("services reach the provider through its interface", () => {
  const tokenization = read("services/billing/src/services/tokenization.service.ts");
  const chargeExec = read("services/billing/src/services/charge-execution.service.ts");

  it("tokenization does not import a named provider adapter", () => {
    // The interface exists so swapping providers is a config change rather than
    // a rewrite. A service reaching past it for iCount specifically makes that
    // claim quietly untrue while its own header still states it.
    expect(tokenization).not.toContain("icount.provider");
    expect(tokenization).toContain("defaultProvider");
  });

  it("charge execution resolves the provider from the payment method", () => {
    // Which provider to charge is a property of the stored card, not a global.
    expect(chargeExec).toContain("getProvider(method.provider)");
    expect(chargeExec).not.toContain("icount.provider");
  });

  it("only the adapter and its own tests name iCount directly", () => {
    const { readdirSync, statSync } = require("node:fs");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "__tests__" && entry !== "providers") walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        if (/from ["'].*icount\.provider["']/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(join(REPO, "services/billing/src"));
    // The adapter lives in providers/; everything else goes through the
    // interface. A new import here is the abstraction leaking again.
    expect(offenders, `named adapter imported by: ${offenders.join(", ")}`).toEqual([]);
  });
});
