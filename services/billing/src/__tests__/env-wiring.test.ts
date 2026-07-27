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

/** Env vars a service's own source reads. */
function varsReadBy(service: string): Set<string> {
  const found = new Set<string>();
  for (const file of tsFilesUnder(join(REPO, "services", service, "src"))) {
    const text = readFileSync(file, "utf8");
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
    "BILLING_ENFORCEMENT_MODE",
    "ICOUNT_WEBHOOK_SECRET",
    "BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY",
  ])("%s appears in .env.example", (name) => {
    // These four have no safe default: checkout misroutes, enforcement fails
    // open, webhooks are rejected, and card storage refuses. Someone setting up
    // a deployment reads this file.
    expect(example).toContain(name);
  });
});
