/**
 * The gateway resolves Authentik per request, never once at startup (2026-10-22).
 *
 * In the prod release window a gateway started while Authentik was stopped
 * refused to start ("host not found in upstream authentik-server:9000"), and
 * after each Authentik recreate it kept the old container IP and answered 502
 * until `nginx -s reload`. A `proxy_pass` to a variable, with Docker's resolver,
 * looks the name up when a request needs it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TEMPLATES = ["nginx/nginx.conf.template", "gateway/nginx.prod.conf.template"];

/** Every location block whose proxy target is Authentik, as [header, body]. */
function authentikLocations(raw: string): Array<[string, string]> {
  const conf = raw.replace(/^\s*#.*$/gm, ""); // comments mention "location" too
  const out: Array<[string, string]> = [];
  const re = /^\s*location ([^{]+)\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(conf))) {
    let depth = 1, i = re.lastIndex;
    while (depth && i < conf.length) { if (conf[i] === "{") depth++; else if (conf[i] === "}") depth--; i++; }
    const body = conf.slice(re.lastIndex, i - 1);
    if (/proxy_pass\s+\S*authentik/.test(body)) out.push([m[1]!.trim(), body]);
  }
  return out;
}

describe.each(TEMPLATES)("%s", (file) => {
  const conf = fs.readFileSync(path.join(ROOT, file), "utf8");

  it("★ has no static upstream for Authentik, and Docker's resolver at http level", () => {
    expect(conf).not.toMatch(/upstream\s+authentik/);
    expect(conf).not.toMatch(/proxy_pass\s+http:\/\/authentik/);
    expect(conf).toMatch(/^    resolver 127\.0\.0\.11 valid=10s ipv6=off;$/m);
  });

  it("★ every Authentik location proxies to the variable it sets itself", () => {
    const locs = authentikLocations(conf);
    expect(locs.map(([h]) => h)).toEqual(["^~ /auth-api/", "^~ /static/", "= /static/dist/custom.css", "/"]);
    for (const [, body] of locs) {
      expect(body).toContain("set $authentik_origin http://authentik-server:${AUTHENTIK_PORT};");
      expect(body).toMatch(/proxy_pass \$authentik_origin;/);
    }
  });

  it("/auth-api/ still reaches /api/v3/ (a variable proxy_pass does no prefix replacement)", () => {
    const [, body] = authentikLocations(conf).find(([h]) => h === "^~ /auth-api/")!;
    expect(body).toMatch(/rewrite \^\/auth-api\/\(\.\*\)\$ \/api\/v3\/\$1 break;/);
    expect(body).toContain("proxy_redirect /api/v3/ /auth-api/;");
    const rewrite = /rewrite (\S+) (\S+) break;/.exec(body)!;
    expect("/auth-api/flows/executor/x/".replace(new RegExp(rewrite[1]!), rewrite[2]!.replace("$1", "$$1")))
      .toBe("/api/v3/flows/executor/x/");
  });
});
