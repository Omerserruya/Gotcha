/**
 * Links Authentik builds work when they reach the app host (2026-10-22).
 *
 * The password-reset email pointed at app.gotcha.co.il/if/flow/... and 404ed:
 * Authentik builds absolute links from X-Forwarded-Host (a trusted proxy's value
 * wins over Host), and /auth-api/ forwarded the APP host. Two fixes, both pinned:
 * /auth-api/ forwards the IdP's own name, and the app host hands Authentik's UI
 * paths (/if/, /flows/) to the IdP for links already sent.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TEMPLATES: Array<[string, string, string]> = [
  ["nginx/nginx.conf.template", "_", "auth-dev.gotcha.co.il"],
  ["gateway/nginx.prod.conf.template", "app.gotcha.co.il", "auth.gotcha.co.il"],
];

function block(conf: string, open: number): string {
  let depth = 1, i = open + 1;
  while (depth && i < conf.length) { if (conf[i] === "{") depth++; else if (conf[i] === "}") depth--; i++; }
  return conf.slice(open + 1, i - 1);
}

/** The server block whose FIRST server_name is `first`, comments removed. */
function server(conf: string, first: string): string {
  const clean = conf.replace(/^\s*#.*$/gm, "");
  const re = /^\s*server\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const body = block(clean, clean.indexOf("{", m.index));
    const name = /server_name\s+([^;\s]+)/.exec(body)?.[1];
    if (name === first) return body;
  }
  throw new Error(`no server named ${first}`);
}

function location(srv: string, header: string): string {
  const at = srv.indexOf(`location ${header} {`);
  if (at < 0) throw new Error(`no location ${header}`);
  return block(srv, srv.indexOf("{", at));
}

describe.each(TEMPLATES)("%s", (file, appName, authHost) => {
  const conf = fs.readFileSync(path.join(ROOT, file), "utf8");
  const app = server(conf, appName);

  it("★ /auth-api/ forwards the IdP's own name, so Authentik's emailed links point at it", () => {
    const b = location(app, "^~ /auth-api/");
    expect(b).toContain(`proxy_set_header Host ${authHost};`);
    expect(b).toContain(`proxy_set_header X-Forwarded-Host ${authHost};`);
    expect(b).not.toMatch(/X-Forwarded-Host \$host/);
  });

  it.each(["/if/", "/flows/"])("★ the app host sends %s to the IdP with path and query", (p) => {
    expect(location(app, `^~ ${p}`).trim()).toBe(`return 302 https://${authHost}$request_uri;`);
  });
});
