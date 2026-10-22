/**
 * A password-reset link lands on the app's own recover screen (2026-10-22).
 *
 * Authentik's email links to <host>/if/flow/gotcha-recovery-self/?flow_token=…
 * and has no setting to point it elsewhere, so the gateway sends that path,
 * WITH a token, to the app's /recover screen on both vhosts; without a token
 * it stays Authentik's. The map's own regex is applied here the way nginx
 * applies it to "$uri|$arg_flow_token".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TEMPLATES: Array<[string, string, string, string]> = [
  ["nginx/nginx.conf.template", "dev.gotcha.co.il", "auth-dev.gotcha.co.il", "_"],
  ["gateway/nginx.prod.conf.template", "app.gotcha.co.il", "auth.gotcha.co.il", "app.gotcha.co.il"],
];

function recoverMap(conf: string): { re: RegExp; target: string } {
  const m = /map "\$uri\|\$arg_flow_token" \$recover_go \{\s*default "";\s*"~([^"]+)" "([^"]+)";\s*\}/.exec(conf);
  if (!m) throw new Error("no $recover_go map");
  // nginx PCRE named groups (?<name>…) are JS-compatible; "\\|" in the file is "\|".
  return { re: new RegExp(m[1]!.replace(/\\\\/g, "\\")), target: m[2]! };
}

/** What $recover_go becomes for a request (nginx: "" when the map does not match). */
function recoverGo(conf: string, uri: string, flowToken: string): string {
  const { re, target } = recoverMap(conf);
  const g = re.exec(`${uri}|${flowToken}`)?.groups;
  return g ? target.replace("$rflow", g.rflow!).replace("$rtok", g.rtok!) : "";
}

function block(conf: string, open: number): string {
  let depth = 1, i = open + 1;
  while (depth && i < conf.length) { if (conf[i] === "{") depth++; else if (conf[i] === "}") depth--; i++; }
  return conf.slice(open + 1, i - 1);
}
function server(conf: string, firstName: string): string {
  const clean = conf.replace(/^\s*#.*$/gm, "");
  const re = /^\s*server\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const body = block(clean, clean.indexOf("{", m.index));
    if (/server_name\s+([^;\s]+)/.exec(body)?.[1] === firstName) return body;
  }
  throw new Error(`no server ${firstName}`);
}

describe.each(TEMPLATES)("%s", (file, appHost, authHost, appServerName) => {
  const conf = fs.readFileSync(path.join(ROOT, file), "utf8");

  it("★ the recovery link WITH a token goes to the app's recover screen, the token untouched", () => {
    expect(recoverGo(conf, "/if/flow/gotcha-recovery-self/", "Ab-c_9%2Bz")).toBe("/recover?flow=gotcha-recovery-self&flow_token=Ab-c_9%2Bz");
  });

  it("no token, an empty token, or another flow: stays Authentik's", () => {
    expect(recoverGo(conf, "/if/flow/gotcha-recovery-self/", "")).toBe("");
    expect(recoverGo(conf, "/if/flow/default-authentication-flow/", "x")).toBe("");
    expect(recoverGo(conf, "/if/flow/gotcha-recovery-self/extra", "x")).toBe("");
  });

  it.each([["auth vhost", authHost], ["app vhost", appServerName]])("★ the %s redirects on it, to the app host", (_label, name) => {
    expect(server(conf, name)).toMatch(new RegExp(`if \\(\\$recover_go != ""\\) \\{\\s*return 302 https://${appHost.replace(/\./g, "\\.")}\\$recover_go;\\s*\\}`));
  });
});
