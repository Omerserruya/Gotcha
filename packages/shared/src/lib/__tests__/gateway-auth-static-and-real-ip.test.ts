/**
 * The Authentik vhost serves /static/ without a rate limit, and every limit is
 * per visitor, not per tunnel (2026-10-22, both found on prod after the release).
 *
 * - Authentik 2026.2's UI loads 100+ chunk files at once. Under the vhost's
 *   `zone=authentik burst=40` most got 429 and the authorize page spun forever.
 * - The only ingress is a host cloudflared, so $remote_addr was the docker
 *   bridge for everybody and each limit was one shared bucket.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TEMPLATES: Array<[string, string]> = [
  ["nginx/nginx.conf.template", "auth-dev.gotcha.co.il"],
  ["gateway/nginx.prod.conf.template", "auth.gotcha.co.il"],
];

/** Body of the `{ ... }` that opens at `open` (index of the brace). */
function block(conf: string, open: number): string {
  let depth = 1, i = open + 1;
  while (depth && i < conf.length) { if (conf[i] === "{") depth++; else if (conf[i] === "}") depth--; i++; }
  return conf.slice(open + 1, i - 1);
}

/** The server block whose server_name lists `host`, comments removed. */
function serverFor(conf: string, host: string): string {
  const clean = conf.replace(/^\s*#.*$/gm, "");
  const re = /^\s*server\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const body = block(clean, clean.indexOf("{", m.index));
    if (new RegExp(`server_name[^;]*\\b${host.replace(/\./g, "\\.")}\\b`).test(body)) return body;
  }
  throw new Error(`no server for ${host}`);
}

function location(server: string, header: string): string {
  const at = server.indexOf(`location ${header} {`);
  if (at < 0) throw new Error(`no location ${header}`);
  return block(server, server.indexOf("{", at));
}

describe.each(TEMPLATES)("%s", (file, authHost) => {
  const conf = fs.readFileSync(path.join(ROOT, file), "utf8");
  const auth = serverFor(conf, authHost);

  it("★ the Authentik vhost's /static/ is proxied with NO limit_req", () => {
    const s = location(auth, "^~ /static/");
    expect(s).toMatch(/proxy_pass \$authentik_origin;/);
    expect(s).not.toMatch(/limit_req/);
  });

  it("the flow and API paths keep the authentik limit", () => {
    expect(location(auth, "/")).toMatch(/limit_req zone=authentik burst=40 nodelay;/);
  });

  it("★ limits are keyed on the visitor: CF-Connecting-IP, trusted only from private ranges", () => {
    const http = conf.replace(/^\s*#.*$/gm, "");
    expect(http).toMatch(/^\s*real_ip_header CF-Connecting-IP;$/m);
    const trusted = [...http.matchAll(/^\s*set_real_ip_from ([^;]+);$/gm)].map((m) => m[1]);
    expect(trusted).toEqual(["127.0.0.1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
    // http level: before the first server block, so every vhost and zone gets it
    expect(http.indexOf("real_ip_header")).toBeLessThan(http.search(/^\s*server\s*\{/m));
  });
});
