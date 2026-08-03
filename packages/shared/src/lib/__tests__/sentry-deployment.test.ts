/**
 * The deployment side of "four projects, production only".
 *
 * The code gate (sentry-init.test.ts) proves a process will not send events
 * outside production. These assert the other half: that the compose file hands
 * each service the DSN for the RIGHT project and no other, and that CI never
 * hands anything the two values that would open the gate.
 *
 * Both are the same class of bug that has bitten this repo repeatedly - a
 * variable that exists in .env, is read by the code, and is never actually
 * handed to the process (or is handed to the wrong one).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SERVICE_PROJECT, type SentryProject } from "../observability/sentry";

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

const DSN_VAR: Record<SentryProject, string> = {
  "core-backend": "SENTRY_CORE_BACKEND_DSN",
  "workers-webhooks": "SENTRY_WORKERS_DSN",
  voice: "SENTRY_VOICE_DSN",
};
const ANCHOR: Record<SentryProject, string> = {
  "core-backend": "sentry-core",
  "workers-webhooks": "sentry-workers",
  voice: "sentry-voice",
};

/** The merge-key anchors each service's environment block pulls in. */
function anchorsByService(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let svc: string | null = null;
  let inEnv = false;
  for (const line of COMPOSE.split("\n")) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { svc = m[1]; inEnv = false; out.set(svc, new Set()); continue; }
    if (!svc) continue;
    if (/^ {4}environment:/.test(line)) { inEnv = true; continue; }
    if (/^ {4}\S/.test(line)) { inEnv = false; continue; }
    if (!inEnv) continue;
    const merge = /^ {6}<<:\s*(.+)$/.exec(line);
    if (merge) {
      for (const a of merge[1].matchAll(/\*([a-z-]+)/g)) out.get(svc)!.add(a[1]);
    }
  }
  return out;
}

describe("compose wires each service to its own project", () => {
  const anchors = anchorsByService();

  it.each(Object.entries(SERVICE_PROJECT))("%s -> %s", (svc, project) => {
    const got = anchors.get(svc);
    expect(got, `${svc} has no environment block in docker-compose.prod.yml`).toBeDefined();
    expect([...got!], `${svc} must pull in *${ANCHOR[project]}`).toContain(ANCHOR[project]);
  });

  /**
   * The failure that matters: a service pulling TWO project anchors would
   * receive two DSNs, and whichever the SDK picked would silently file its
   * issues in the wrong project.
   */
  it("gives no service more than one project anchor", () => {
    const sentryAnchors = new Set(Object.values(ANCHOR));
    const offenders: string[] = [];
    for (const [svc, set] of anchors) {
      const n = [...set].filter((a) => sentryAnchors.has(a));
      if (n.length > 1) offenders.push(`${svc}: ${n.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("defines all three anchors and the shared block", () => {
    for (const a of [...Object.values(ANCHOR), "sentry-common"]) {
      expect(COMPOSE, `missing anchor &${a}`).toMatch(new RegExp(`&${a}\\b`));
    }
  });

  it("defaults every DSN to empty so unset means off", () => {
    for (const v of Object.values(DSN_VAR)) {
      expect(COMPOSE).toMatch(new RegExp(`${v}:\\s*\\$\\{${v}:-\\}`));
    }
  });

  /**
   * The gateway serves a static export. There is no Node process, so a backend
   * DSN there would be dead config that looks like coverage.
   */
  it("gives the gateway no backend DSN", () => {
    const gw = anchors.get("gateway") ?? new Set();
    for (const a of Object.values(ANCHOR)) expect([...gw]).not.toContain(a);
  });
});

describe("CI cannot send events", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];

  it("has workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * initSentry needs NODE_ENV=production AND SENTRY_ENVIRONMENT=production. CI
   * legitimately builds production artifacts, so the second value is the one
   * that must never appear in a test or build job.
   */
  it.each(files)("%s never sets SENTRY_ENVIRONMENT=production", (f) => {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    expect(src).not.toMatch(/SENTRY_ENVIRONMENT\s*:\s*["']?production/);
  });

  it.each(files)("%s never injects a runtime DSN", (f) => {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const v of [...Object.values(DSN_VAR), "SENTRY_FRONTEND_DSN"]) {
      expect(src, `${f} sets ${v}`).not.toMatch(new RegExp(`${v}\\s*:`));
    }
  });
});
