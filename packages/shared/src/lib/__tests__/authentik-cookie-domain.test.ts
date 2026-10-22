/**
 * Authentik's session cookie covers BOTH names the sign-in flow runs on (2026-10-22).
 *
 * The app's sign-in panel drives Authentik's flow executor at <app host>/auth-api/
 * and hands over to the Authentik vhost for stages it does not draw. One
 * session must survive both, so the cookie domain has to be a parent of each.
 * Prod broke on exactly this: the box .env overrode the compose default with
 * auth.gotcha.co.il, the browser dropped the cookie on app.gotcha.co.il, and
 * every sign-in restarted at the email step.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** RFC 6265 domain-match: the host is the domain or a subdomain of it. */
function cookieCovers(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** server_name of the server block that contains `needle`, first real name. */
function hostOf(conf: string, needle: RegExp): string {
  const at = conf.search(needle);
  if (at < 0) throw new Error(`not found: ${needle}`);
  const before = conf.slice(0, at);
  const names = [...before.matchAll(/^\s*server_name\s+([^;]+);/gm)];
  const last = names[names.length - 1];
  if (!last) throw new Error("no server_name before it");
  const first = last[1]!.split(/\s+/).find((n) => n && n !== "_");
  if (!first) throw new Error("server block has no real name");
  return first;
}

describe("prod: docker-compose.prod.yml + gateway/nginx.prod.conf.template", () => {
  const compose = read("docker-compose.prod.yml");
  const conf = read("gateway/nginx.prod.conf.template");

  it("★ the cookie domain is FIXED, so no .env can narrow it", () => {
    const lines = compose.split("\n").filter((l) => /^\s+AUTHENTIK_COOKIE_DOMAIN:/.test(l));
    expect(lines).toHaveLength(1); // one anchor, shared by server and worker
    expect(lines[0]!.trim()).toBe("AUTHENTIK_COOKIE_DOMAIN: gotcha.co.il");
  });

  it("★ it covers the app host serving /auth-api/ AND the Authentik vhost", () => {
    const app = hostOf(conf, /location \^~ \/auth-api\/ \{/);
    const auth = hostOf(conf, /location \/ \{\s*limit_req zone=authentik/);
    expect([app, auth]).toEqual(["app.gotcha.co.il", "auth.gotcha.co.il"]);
    expect(cookieCovers("gotcha.co.il", app)).toBe(true);
    expect(cookieCovers("gotcha.co.il", auth)).toBe(true);
    // The value that broke prod covers only one of them.
    expect(cookieCovers("auth.gotcha.co.il", app)).toBe(false);
  });
});

describe("dev: docker-compose.yml default", () => {
  it("covers dev's app host and auth-dev", () => {
    const m = /AUTHENTIK_COOKIE_DOMAIN: \$\{AUTHENTIK_COOKIE_DOMAIN:-([^}]+)\}/.exec(read("docker-compose.yml"));
    expect(m).not.toBeNull();
    for (const h of ["dev.gotcha.co.il", "auth-dev.gotcha.co.il"]) expect(cookieCovers(m![1]!, h)).toBe(true);
  });
});
