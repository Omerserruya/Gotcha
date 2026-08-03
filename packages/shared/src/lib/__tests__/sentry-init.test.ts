/**
 * Sentry is production-only, and the test suite proves it by making a violation
 * impossible rather than merely unobserved.
 *
 * The strongest available assertion is not "no HTTP request was made" - it is
 * that the SDK is never LOADED. initSentry requires "@sentry/node" lazily and
 * only after the environment gate, so a module-load trap that throws on that
 * specifier is a hard proof that no client, no transport and no queue was ever
 * constructed in a test, in CI, or on a developer machine.
 *
 * That is why these tests need no mock DSN server and no network stubbing: the
 * code path that could reach a network is never entered.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  initSentry, resolveDsn, isProductionSentry, captureError,
  SERVICE_PROJECT, __resetSentryForTests,
} from "../observability/sentry";

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

/** Env that WOULD initialise, so each test isolates one missing condition. */
const prodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  SENTRY_ENVIRONMENT: "production",
  SENTRY_CORE_BACKEND_DSN: DSN,
  SENTRY_WORKERS_DSN: DSN,
  SENTRY_VOICE_DSN: DSN,
  ...over,
});

// ── module-load trap ────────────────────────────────────────────────────────
const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
let sdkLoadAttempts: string[] = [];

beforeEach(() => {
  __resetSentryForTests();
  sdkLoadAttempts = [];
  (Module as unknown as { _load: unknown })._load = function (request: string, ...rest: unknown[]) {
    if (typeof request === "string" && request.startsWith("@sentry/")) {
      sdkLoadAttempts.push(request);
      throw new Error(`TEST GUARD: refused to load ${request}`);
    }
    return (realLoad as (...a: unknown[]) => unknown).call(this, request, ...rest);
  };
});
afterEach(() => {
  (Module as unknown as { _load: unknown })._load = realLoad;
  __resetSentryForTests();
});

describe("production gate", () => {
  it("does not initialise under the suite's own environment", () => {
    // No env argument: whatever the test runner actually sets.
    const r = initSentry("auth");
    expect(r.enabled).toBe(false);
    expect(sdkLoadAttempts, "the SDK must never be loaded in a test").toEqual([]);
  });

  it.each([
    ["NODE_ENV missing", { NODE_ENV: "development" }],
    ["NODE_ENV=test", { NODE_ENV: "test" }],
    ["SENTRY_ENVIRONMENT=staging", { SENTRY_ENVIRONMENT: "staging" }],
    ["SENTRY_ENVIRONMENT=development", { SENTRY_ENVIRONMENT: "development" }],
    ["SENTRY_ENVIRONMENT missing", { SENTRY_ENVIRONMENT: "" }],
  ])("refuses to initialise when %s, even with a valid DSN", (_label, over) => {
    const r = initSentry("auth", prodEnv(over as Record<string, string>));
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("not_production");
    expect(sdkLoadAttempts).toEqual([]);
  });

  /**
   * The environment check must come BEFORE the DSN lookup. If it came second, a
   * CI job holding a real DSN would take the initialise path and only be saved
   * by whatever came next.
   */
  it("checks the environment before it even reads the DSN", () => {
    const r = initSentry("auth", { NODE_ENV: "test", SENTRY_CORE_BACKEND_DSN: DSN });
    expect(r.reason).toBe("not_production");
  });

  it("still does nothing in production without a DSN", () => {
    const r = initSentry("auth", prodEnv({ SENTRY_CORE_BACKEND_DSN: "" }));
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("no_dsn");
    expect(sdkLoadAttempts).toEqual([]);
  });

  it("only attempts to load the SDK once BOTH conditions and a DSN are present", () => {
    const r = initSentry("auth", prodEnv());
    // The trap makes the load fail, which is exactly what we want to observe:
    // the attempt proves the gate opened, the failure proves nothing was sent.
    expect(sdkLoadAttempts).toEqual(["@sentry/node"]);
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("init_failed");
  });

  it("captureError is inert when nothing was initialised", () => {
    expect(() => captureError(new Error("boom"), { job: "x" })).not.toThrow();
    expect(sdkLoadAttempts).toEqual([]);
  });

  it.each([
    [{ NODE_ENV: "production", SENTRY_ENVIRONMENT: "production" }, true],
    [{ NODE_ENV: "production", SENTRY_ENVIRONMENT: "staging" }, false],
    [{ NODE_ENV: "staging", SENTRY_ENVIRONMENT: "production" }, false],
    [{}, false],
  ])("isProductionSentry(%o) === %s", (env, expected) => {
    expect(isProductionSentry(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("four projects, and only four", () => {
  it("maps every service to one of exactly three backend projects", () => {
    expect([...new Set(Object.values(SERVICE_PROJECT))].sort())
      .toEqual(["core-backend", "voice", "workers-webhooks"]);
  });

  /**
   * A service missing from the table gets no Sentry at all - the failure mode
   * that stays invisible until the incident it would have caught.
   */
  it("covers every service in the repository", () => {
    const dir = path.join(__dirname, "..", "..", "..", "..", "..", "services");
    const services = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "package.json")))
      .map((e) => e.name);
    const missing = services.filter((s) => !(s in SERVICE_PROJECT)).sort();
    expect(missing, "add these to SERVICE_PROJECT or they report nowhere").toEqual([]);
  });

  it("routes each service to its project's DSN variable", () => {
    const env = prodEnv({
      SENTRY_CORE_BACKEND_DSN: "core", SENTRY_WORKERS_DSN: "workers", SENTRY_VOICE_DSN: "voice",
    });
    expect(resolveDsn("auth", env)).toBe("core");
    expect(resolveDsn("billing", env)).toBe("core");
    expect(resolveDsn("webhook", env)).toBe("workers");
    expect(resolveDsn("incoming-worker", env)).toBe("workers");
    expect(resolveDsn("voice-copilot", env)).toBe("voice");
  });

  it("returns nothing for a service that is not mapped", () => {
    expect(resolveDsn("not-a-service", prodEnv())).toBe("");
    expect(initSentry("not-a-service", prodEnv()).reason).toBe("service_not_mapped");
  });
});
