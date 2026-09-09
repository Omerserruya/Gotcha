/**
 * Every environment variable the service reads must actually reach it.
 *
 * This check was run by hand once and found that BILLING_ENFORCEMENT_MODE was
 * declared in the dev compose and nowhere in the production one. Undeclared, it
 * defaults to "off", which fails OPEN - so the gate refusing service to unpaid
 * organizations would have been silently inert in production while the dev
 * stack looked correct. APP_PUBLIC_URL was missing from both, which would have
 * landed customers somewhere arbitrary after paying.
 *
 * Neither breaks anything visibly. A missing variable is `undefined`, code takes
 * its default, and the system carries on doing the wrong thing quietly. That is
 * the whole reason this is worth automating: the failure has no symptom until a
 * customer or an accountant finds it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "../../../..");

/** Provided by the runtime, not by us. */
const AMBIENT = new Set(["NODE_ENV", "HOSTNAME", "PORT", "PWD", "HOME", "PATH", "npm_package_version"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist" && entry !== "__tests__") walk(full);
        continue;
      }
      if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Strip comments before scanning.
 *
 * Only a read in CODE is a read. A variable NAMED in a comment - and this file
 * is exactly the sort of thing code comments explain, so they do name them -
 * is not configuration the service needs, and counting it demands that compose
 * declare a variable that does not exist. The check then fails for a reason
 * that has nothing to do with the wiring it is guarding.
 *
 * The `//` case guards against a preceding `:` so a `https://` inside a string
 * literal does not swallow the rest of its line and hide a real read.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Env vars a service's own source reads. */
function varsReadBy(service: string): Set<string> {
  const found = new Set<string>();
  for (const file of tsFilesUnder(join(REPO, "services", service, "src"))) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) found.add(m[1]);
  }
  for (const v of AMBIENT) found.delete(v);
  return found;
}

/** The environment block of one service in one compose file. */
function composeBlock(file: string, service: string): string {
  const text = readFileSync(join(REPO, file), "utf8");
  const m = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_-]+:\\n)`).exec(text);
  return m ? m[1] : "";
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"];

describe("billing's configuration reaches the container", () => {
  const read = varsReadBy("billing");

  it("reads a plausible number of variables", () => {
    // Guards the guard: a broken matcher finding nothing would make every
    // assertion below pass while checking nothing at all.
    expect(read.size).toBeGreaterThan(10);
  });

  it.each(COMPOSE_FILES)("every one is declared in %s", (file) => {
    const block = composeBlock(file, "billing");
    expect(block.length, `no billing service block found in ${file}`).toBeGreaterThan(0);

    const missing = [...read].filter((v) => !block.includes(v)).sort();
    // A missing variable is undefined, the code takes its default, and nothing
    // looks broken. That silence is the danger.
    expect(missing, `${file} does not pass these to billing:\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});

describe("the enforcement gate is configured where it is evaluated", () => {
  // checkAiAllowed runs in the ai service. Declaring the mode only for billing
  // would configure the panel that REPORTS enforcement without configuring the
  // gate that performs it.
  it.each(COMPOSE_FILES)("ai receives BILLING_ENFORCEMENT_MODE in %s", (file) => {
    expect(composeBlock(file, "ai")).toContain("BILLING_ENFORCEMENT_MODE");
  });

  it.each(COMPOSE_FILES)("billing receives it too, so the preview cannot disagree in %s", (file) => {
    expect(composeBlock(file, "billing")).toContain("BILLING_ENFORCEMENT_MODE");
  });

  it("both default to the same value", () => {
    // A preview reading `off` while the gate reads `hard` would tell an
    // operator nobody is being refused while customers were being refused.
    for (const file of COMPOSE_FILES) {
      const ai = /BILLING_ENFORCEMENT_MODE:\s*\$\{BILLING_ENFORCEMENT_MODE:-(\w*)\}/.exec(composeBlock(file, "ai"));
      const billing = /BILLING_ENFORCEMENT_MODE:\s*\$\{BILLING_ENFORCEMENT_MODE:-(\w*)\}/.exec(composeBlock(file, "billing"));
      expect(ai?.[1], `${file}: ai has no default`).toBeTruthy();
      expect(billing?.[1], `${file}: billing has no default`).toBe(ai?.[1]);
    }
  });
});

describe("what a deployer needs to know is written down", () => {
  const example = readFileSync(join(REPO, ".env.example"), "utf8");

  it.each([
    "APP_PUBLIC_URL",
    "APP_PUBLIC_URL_ALLOWED_HOSTS",
    "BILLING_ENFORCEMENT_MODE",
    "BILLING_PAST_DUE_GRACE_HOURS",
    "BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY",
    "BOI_FX_ENABLED",
    "BOI_FX_MAX_STALENESS_HOURS",
    "ICOUNT_CHECKOUT_ENABLED",
    "ICOUNT_TOKENIZATION_ENABLED",
    "ICOUNT_STORED_CARD_CHARGE_ENABLED",
    "SELF_SERVE_CHECKOUT_ENABLED",
  ])("%s appears in .env.example", (name) => {
    // These four have no safe default: checkout misroutes, enforcement fails
    // open, webhooks are rejected, and card storage refuses. Someone setting up
    // a deployment reads this file.
    expect(example).toContain(name);
  });
});

/**
 * Every service that can produce billable work must be able to refuse it.
 *
 * Found by hand, and the reason this is now automated: only `ai` and `billing`
 * received BILLING_ENFORCEMENT_MODE. conversation, chatbot, voice-copilot and
 * both workers defaulted to "off" - five services doing billable work with the
 * gate silently inert, each of them a way in. Nothing about that state looks
 * wrong from the outside, which is exactly why nobody had noticed.
 */
describe("every billable service can refuse work", () => {
  const BILLABLE = [
    "ai",
    "billing",
    "conversation",
    "chatbot",
    "voice-copilot",
    "incoming-worker",
    "outgoing-worker",
  ];

  it.each(COMPOSE_FILES)("%s declares the enforcement mode for all of them", (file) => {
    const missing = BILLABLE.filter((svc) => !composeBlock(file, svc).includes("BILLING_ENFORCEMENT_MODE"));
    expect(
      missing,
      `${file}: these produce billable work but cannot refuse it:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it.each(COMPOSE_FILES)("%s gives them all the SAME default", (file) => {
    // Different defaults per service means enforcement is on in one place and
    // off in another, which is worse than off everywhere: the behaviour depends
    // on which service happens to handle a request.
    const defaults = new Set(
      BILLABLE.map((svc) => {
        const m = /BILLING_ENFORCEMENT_MODE:\s*\$\{BILLING_ENFORCEMENT_MODE:-(\w*)\}/.exec(composeBlock(file, svc));
        return m?.[1];
      }),
    );
    expect([...defaults], `${file}: services disagree on the default`).toHaveLength(1);
  });

  it.each(COMPOSE_FILES)("%s defaults to enforcing, not to off", (file) => {
    const m = /BILLING_ENFORCEMENT_MODE:\s*\$\{BILLING_ENFORCEMENT_MODE:-(\w*)\}/.exec(composeBlock(file, "billing"));
    // "off" as a default means an unconfigured deployment quietly stops
    // requiring anyone to pay.
    expect(["enforce", "hard"]).toContain(m?.[1]);
  });
});

describe("payment capabilities are off unless someone turned them on", () => {
  const CAPABILITIES = [
    "ICOUNT_CHECKOUT_ENABLED",
    "ICOUNT_TOKENIZATION_ENABLED",
    "ICOUNT_STORED_CARD_CHARGE_ENABLED",
    "SELF_SERVE_CHECKOUT_ENABLED",
  ];

  it.each(COMPOSE_FILES)("%s defaults every capability to false", (file) => {
    const block = composeBlock(file, "billing");
    for (const cap of CAPABILITIES) {
      const m = new RegExp(`${cap}:\\s*\\$\\{${cap}:-(\\w*)\\}`).exec(block);
      expect(m, `${file}: ${cap} is not declared for billing`).toBeTruthy();
      // A payment capability that switches itself on takes someone's money
      // somewhere nobody intended.
      expect(m?.[1], `${file}: ${cap} does not default to false`).toBe("false");
    }
  });
});

describe("the two compose files do not drift apart", () => {
  /**
   * Parsed as YAML, not scanned as text.
   *
   * Production uses anchors (`<<: *oidc-env`) to share common variables, which
   * a regex over the service's own block cannot see - it reported OIDC_ISSUER
   * and OIDC_JWKS_URI as missing from production when they are inherited and
   * present. A drift check that cries wolf gets switched off, so it has to
   * resolve the file the way Docker does.
   */
  function envOf(file: string, service: string): Set<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const YAML = require("yaml");
    // `merge: true` resolves `<<: *anchor`. Without it, production's shared
    // OIDC block reads as absent and the check reports a gap that is not there.
    const doc = YAML.parse(readFileSync(join(REPO, file), "utf8"), { merge: true });
    const env = doc?.services?.[service]?.environment ?? {};
    return new Set(Object.keys(env));
  }

  it("declares in production everything dev declares for billing", () => {
    // The failure this file exists for: BILLING_ENFORCEMENT_MODE was in dev and
    // absent from production, so the dev stack looked correct while production
    // ran unenforced. It happened again with PUBLIC_PRICING_ENABLED, where the
    // gateway served /pricing while the API behind it 404'd the catalog.
    const dev = envOf("docker-compose.yml", "billing");
    const prod = envOf("docker-compose.prod.yml", "billing");

    const missing = [...dev].filter((n) => !prod.has(n)).sort();
    expect(
      missing,
      `declared for billing in dev but NOT production:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * Deliberately NOT asserting equal defaults.
   *
   * Dev and production legitimately differ - NODE_ENV, DATABASE_URL, and the
   * `:?required in prod` markers are all meant to. A check that flagged those
   * would report five false alarms every run and be switched off within a week,
   * taking the real check above with it.
   */
});
