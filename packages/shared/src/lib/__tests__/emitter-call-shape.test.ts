/**
 * Every emitter call site, checked against the contract the alerts rely on.
 *
 * The runtime helper tests prove the helper behaves. These prove the CALLERS
 * hold up their end - which is where the mistakes actually happen. A call site
 * with a bad `service` files into the wrong Sentry project; one with a message
 * or a token in its context leaks it; one with a made-up domain breaks the
 * dashboards. None of those fail at runtime, and none are visible in review
 * once there are thirty of them.
 *
 * Static rather than runtime because the alternative is booting eleven services
 * with mocked databases to observe a tag - and a test that expensive is a test
 * that gets deleted.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES } from "../observability/error-codes";
import { SERVICE_PROJECT } from "../observability/sentry";
import { assertSafeContext, UnsafeContextError } from "../observability/operational-failure";

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try { if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir; } catch { /* walk */ }
    }
    dir = path.dirname(dir);
  }
  throw new Error("workspace root not found");
}
const ROOT = repoRoot();

const VALID_DOMAINS = new Set([
  // Mirrors FailureDomain in lib/observability/operational-failure.ts.
  // "media" is attachment STORAGE, not delivery: the owner is an operator with
  // shell access, not whoever watches webhooks.
  "ai", "hitl", "integration", "webhook", "billing", "voice", "security", "action", "media",
]);

interface CallSite {
  file: string;
  errorCode: string;
  domain: string;
  service: string;
  provider?: string;
  contextKeys: string[];
}

/** Extract every reportOperationalFailure({...}) literal from production code. */
function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "__tests__", "dist"].includes(e.name)) continue;
        walk(f); continue;
      }
      if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      const src = fs.readFileSync(f, "utf8");
      // The helper's own definition is not a call site.
      if (f.endsWith(path.join("observability", "operational-failure.ts"))) continue;
      for (const m of src.matchAll(/reportOperationalFailure\(\{([\s\S]*?)\n\s*\}\);/g)) {
        const body = m[1];
        const pick = (k: string) => {
          const r = new RegExp(`${k}:\\s*(?:ERROR_CODES\\.(\\w+)|"([^"]+)"|String\\(([^)]*)\\)|(\\w+))`).exec(body);
          return r ? (r[1] ?? r[2] ?? "<dynamic>") : undefined;
        };
        const ctx = /context:\s*\{([^}]*)\}/.exec(body);
        sites.push({
          file: path.relative(ROOT, f),
          errorCode: pick("errorCode") ?? "<missing>",
          domain: pick("domain") ?? "<missing>",
          service: pick("service") ?? "<missing>",
          provider: pick("provider"),
          contextKeys: ctx ? [...ctx[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]) : [],
        });
      }
    }
  };
  walk(path.join(ROOT, "services"));
  walk(path.join(ROOT, "packages"));
  return sites;
}

const SITES = callSites();
const CODES = new Set(Object.values(ERROR_CODES) as string[]);

describe("emitter call sites", () => {
  it("finds the emitters (a scan that finds nothing proves nothing)", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(20);
  });

  it.each(SITES.map((s) => [`${s.errorCode} @ ${s.file}`, s] as const))(
    "%s uses a real error code", (_label, s) => {
      if (s.errorCode === "<dynamic>") {
        // A computed code - ai.service.ts classifies the failure and returns an
        // ERROR_CODES value. The type system guarantees the value; the scanner
        // cannot see through the call, so it checks the file uses the taxonomy.
        const src = fs.readFileSync(path.join(ROOT, s.file), "utf8");
        expect(src, `${s.file} computes an error code without importing the taxonomy`)
          .toContain("ERROR_CODES");
        return;
      }
      expect(CODES.has(s.errorCode), `${s.errorCode} is not in ERROR_CODES`).toBe(true);
    });

  it.each(SITES.map((s) => [`${s.errorCode} @ ${s.file}`, s] as const))(
    "%s uses a valid domain", (_label, s) => {
      expect(VALID_DOMAINS.has(s.domain), `${s.domain} is not a FailureDomain`).toBe(true);
    });

  /**
   * `service` decides the Sentry PROJECT. A typo here does not throw - it just
   * files the issue nowhere, which is the failure that looks like silence.
   */
  it.each(SITES.map((s) => [`${s.errorCode} @ ${s.file}`, s] as const))(
    "%s names a service that maps to a project", (_label, s) => {
      // "shared" is the library itself; it inherits the host service's project.
      if (s.service === "shared") return;
      expect(SERVICE_PROJECT[s.service], `${s.service} has no Sentry project`).toBeDefined();
    });

  /**
   * The one with real consequences. Every context key is run through the same
   * guard the runtime uses, so a prompt, message, token, email or phone in any
   * call site fails here rather than appearing in Sentry.
   */
  it.each(SITES.map((s) => [`${s.errorCode} @ ${s.file}`, s] as const))(
    "%s carries no unsafe context key", (_label, s) => {
      const fake = Object.fromEntries(s.contextKeys.map((k) => [k, "x"]));
      expect(
        () => assertSafeContext(fake, { NODE_ENV: "test" } as NodeJS.ProcessEnv),
        `unsafe context key in ${s.file}: ${s.contextKeys.join(", ")}`,
      ).not.toThrow(UnsafeContextError);
    });

  /** Every domain that has emitters should be reachable from an alert rule. */
  it("covers each product domain", () => {
    const domains = new Set(SITES.map((s) => s.domain));
    for (const d of ["ai", "hitl", "integration", "webhook", "billing", "voice", "security"]) {
      expect(domains.has(d), `no emitter in domain ${d}`).toBe(true);
    }
  });
});
