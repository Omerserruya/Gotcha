/**
 * Environment a service needs to BOOT, asserted against the prod compose file.
 *
 * These fail closed by design - a service that cannot prove it is allowed to do
 * billable work refuses to start rather than serving for free, and one that
 * cannot sign OAuth state refuses rather than signing with a weak secret. That
 * is the right behaviour. The problem is that the contract lived only inside
 * the service, and docker-compose.prod.yml was never checked against it.
 *
 * On the first real production boot, four services crash-looped:
 *
 *   auth, webhook, analytics    [billing] BILLING_ENFORCEMENT_MODE is not set.
 *   ai                          [oauth-state] OAUTH_STATE_SECRET is required.
 *
 * and the gateway then crash-looped too, because nginx resolves every upstream
 * at startup and refuses to start when one is missing. So four missing
 * environment variables presented as a total outage with a 502.
 *
 * None of it was reachable in dev: the dev compose sets these, and no test
 * booted a service with the production compose file.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  throw new Error("workspace root not found");
}
const ROOT = repoRoot();
const COMPOSE = fs.readFileSync(path.join(ROOT, "docker-compose.prod.yml"), "utf8");

/** Environment keys docker-compose.prod.yml gives each service. */
function envByService(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let svc: string | null = null;
  let inEnv = false;
  for (const line of COMPOSE.split("\n")) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { svc = m[1]; inEnv = false; out.set(svc, new Set()); continue; }
    if (!svc) continue;
    if (/^ {4}environment:/.test(line)) { inEnv = true; continue; }
    if (/^ {4}\S/.test(line)) { inEnv = false; continue; }
    const kv = /^ {6}([A-Z_0-9]+):/.exec(line);
    if (inEnv && kv) out.get(svc)!.add(kv[1]);
  }
  return out;
}

/** Services whose src/index.ts boots through startService(). */
function servicesUsingStartService(): string[] {
  const dir = path.join(ROOT, "services");
  return fs.readdirSync(dir).filter((s) => {
    const idx = path.join(dir, s, "src", "index.ts");
    if (!fs.existsSync(idx)) return false;
    return /startService|createServiceApp/.test(fs.readFileSync(idx, "utf8"));
  });
}

/** Services whose source mints or consumes OAuth state. */
function servicesUsingOAuthState(): string[] {
  const dir = path.join(ROOT, "services");
  const hit: string[] = [];
  const walk = (d: string): boolean => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (!/\.ts$/.test(e.name) || p.includes("__tests__")) continue;
      if (/mintOAuthState|consumeOAuthState/.test(fs.readFileSync(p, "utf8"))) return true;
    }
    return false;
  };
  for (const s of fs.readdirSync(dir)) {
    const src = path.join(dir, s, "src");
    if (fs.existsSync(src) && walk(src)) hit.push(s);
  }
  return hit;
}

describe("production boot contracts", () => {
  const env = envByService();

  it("every service booting through startService() gets BILLING_ENFORCEMENT_MODE", () => {
    const missing = servicesUsingStartService()
      .filter((s) => env.has(s))
      .filter((s) => !env.get(s)!.has("BILLING_ENFORCEMENT_MODE"))
      .sort();
    expect(missing, "assertEnforcementConfigured() throws at boot without it").toEqual([]);
  });

  it("every service that signs OAuth state gets OAUTH_STATE_SECRET", () => {
    const missing = servicesUsingOAuthState()
      .filter((s) => env.has(s))
      .filter((s) => !env.get(s)!.has("OAUTH_STATE_SECRET"))
      .sort();
    expect(missing, "mintOAuthState() throws at boot without it in production").toEqual([]);
  });
});

describe("production nginx upstreams", () => {
  const conf = fs.readFileSync(path.join(ROOT, "gateway/nginx.prod.conf.template"), "utf8");

  /**
   * nginx resolves EVERY upstream at startup and refuses to start if one does
   * not resolve, so a single stale name takes the entire gateway down rather
   * than just the route that uses it.
   */
  it("proxies only to hosts that exist as services in the prod compose file", () => {
    const services = new Set(
      [...COMPOSE.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]),
    );
    // Upstream blocks resolve to `service:port`; direct proxy_pass may name a
    // service or an upstream block.
    const upstreamNames = new Set(
      [...conf.matchAll(/upstream\s+([a-z_][a-z0-9_]*)\s*\{/g)].map((m) => m[1]),
    );
    const proxied = [...conf.matchAll(/proxy_pass\s+https?:\/\/([a-z][a-z0-9_-]*)/g)].map((m) => m[1]);
    const dangling = [...new Set(proxied)]
      .filter((h) => !upstreamNames.has(h) && !services.has(h))
      .sort();
    expect(dangling, "nginx will refuse to start: host not found in upstream").toEqual([]);
  });

  it("names no `frontend` container - the static export is baked into the image", () => {
    expect(conf).not.toMatch(/proxy_pass\s+https?:\/\/frontend/);
  });
});
