/**
 * The gateway's old-path map never redirects a page to itself (2026-10-21).
 *
 * The map was written for /v2 (old path -> /v2/new path). At the root, an old
 * path that kept its name (/approvals, /settings/security, /settings/billing)
 * mapped to itself, and a visitor without a language cookie looped 302 x6 on
 * dev. `$v2_go` is the map's target, emptied when its path equals the request's;
 * `location /` redirects on that, never on `$v2_dest` directly.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TEMPLATES = ["nginx/nginx.conf.template", "gateway/nginx.prod.conf.template"];

/** The guard's own regex, applied the way nginx applies it to "$v2_dest|$uri". */
function guardRegex(conf: string): RegExp {
  const m = /map "\$v2_dest\|\$uri" \$v2_go \{\s*default \$v2_dest;\s*"~([^"]+)" "";/.exec(conf);
  if (!m) throw new Error("no $v2_go guard map");
  return new RegExp(m[1]!.replace(/\\\\/g, "\\"));
}

describe.each(TEMPLATES)("%s", (file) => {
  const conf = fs.readFileSync(path.join(ROOT, file), "utf8");

  it("★ redirects on the guarded value only", () => {
    expect(conf).toMatch(/if \(\$v2_go != ""\) \{ return 302 \$v2_go; \}/);
    expect(conf).not.toMatch(/return 302 \$v2_dest;/);
  });

  it("★ the guard empties a self-redirect and keeps a real one", () => {
    const rx = guardRegex(conf);
    // Same path (with or without a query on the target, a trailing slash on the request): no redirect.
    expect(rx.test("/approvals|/approvals")).toBe(true);
    expect(rx.test("/settings/billing?x=1|/settings/billing")).toBe(true);
    expect(rx.test("/settings/security|/settings/security/")).toBe(true);
    // A different path: the redirect stands.
    expect(rx.test("/inbox?c=a|/conversations")).toBe(false);
    expect(rx.test("/settings/systems|/settings/business-systems")).toBe(false);
  });
});
