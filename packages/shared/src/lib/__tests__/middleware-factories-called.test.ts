import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join } from "path";

/**
 * A middleware factory passed uncalled hangs the request forever.
 *
 * `services/auth/src/routes/knowledge-backfill.ts` had:
 *
 *     router.use(authenticate, requireSystemAdmin, crossTenantMiddleware);
 *                              ^^^^^^^^^^^^^^^^^^ no ()
 *
 * `requireSystemAdmin` is a factory. Express invoked it as (req, res, next); it
 * ignored those, returned a function, and never called next(). The request then
 * sat there until the gateway gave up at 504 - no error, no log, no response.
 *
 * The blast radius came from the second half: a path-less `router.use` on a
 * router mounted at "/api/system" alongside two others, so it ran for EVERY
 * /api/system/* request. One missing pair of parentheses froze the entire
 * sysadmin console - tenants, stats, onboarding-console - none of which that
 * file has anything to do with. Unauthenticated callers still got a fast 401,
 * because `authenticate` rejected before reaching it, so every health check and
 * smoke probe said the service was fine.
 *
 * TypeScript does not catch it: `RequestHandler` and `() => RequestHandler` are
 * both callable with three arguments as far as Express's loose typings care.
 * So it is checked here instead.
 */

const REPO = join(__dirname, "..", "..", "..", "..", "..");

/**
 * Middleware FACTORIES - functions that must be called to produce middleware.
 *
 * Plain middleware (`authenticate`, `resolveTenant`, `crossTenantMiddleware`)
 * is deliberately absent: passing those uncalled is correct.
 */
const FACTORIES = [
  "requireSystemAdmin",
  "requireRole",
  "requirePermission",
  "requirePermissionOrRole",
  "requireFeature",
  "requireEntitlement",
  "requireCapacity",
  "requireActiveTenant",
  "requireOnboardingOrActiveTenant",
  "requirePlatformPermission",
  "requireDepartmentRole",
  "validate",
];

/** Route registrations that pass a factory by reference instead of calling it. */
function offendingLines(): string[] {
  const alternation = FACTORIES.join("|");
  // A factory name immediately followed by "," or ")" - i.e. never invoked -
  // inside a router/app registration call.
  const pattern =
    `(router|app)\\.(use|get|post|put|patch|delete|all)\\(.*[,(][[:space:]]*(${alternation})[[:space:]]*[,)]`;
  try {
    const out = execSync(
      `grep -rnE '${pattern}' services --include=*.ts 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean).filter((l) => !l.includes("__tests__"));
  } catch {
    return [];
  }
}

describe("every middleware factory is actually called", () => {
  it("the scan itself works", () => {
    // Guards against a silently-broken regex reporting a clean codebase.
    // This string matches the pattern and must be found by it.
    const probe = `router.use(authenticate, requireSystemAdmin, crossTenant);`;
    const re = new RegExp(
      `(router|app)\\.(use|get|post)\\(.*[,(]\\s*(${FACTORIES.join("|")})\\s*[,)]`,
    );
    expect(re.test(probe), "the detection pattern does not match a known-bad line").toBe(true);
  });

  it("no route passes a factory uncalled", () => {
    const offenders = offendingLines();
    expect(
      offenders,
      "these pass a middleware FACTORY by reference. Express will call it as " +
        "(req, res, next), it will return a function instead of calling next(), " +
        "and every matching request will hang until the gateway times out:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("does not flag correctly-called factories", () => {
    // The counter-check: this test must not be satisfiable by a pattern that
    // matches nothing. `requireSystemAdmin()` appears all over the codebase.
    const called = execSync(
      `grep -rn 'requireSystemAdmin()' services --include=*.ts 2>/dev/null | wc -l`,
      { cwd: REPO, encoding: "utf-8" },
    ).trim();
    expect(Number(called)).toBeGreaterThan(3);
  });
});
