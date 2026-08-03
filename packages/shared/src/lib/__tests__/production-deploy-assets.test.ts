/**
 * The production box needs more than two files, and forgetting one fails badly.
 *
 * `docker-compose.prod.yml` bind-mounts a handful of host files into the
 * Authentik containers (branding, the password-reset email template). The box
 * otherwise runs images only, which is why it is easy to believe - as DEPLOY.md
 * used to say - that it needs just the compose file and `.env`.
 *
 * Forgetting one does not produce a missing-file error. Docker auto-creates the
 * missing bind source as an empty DIRECTORY and then refuses to mount a
 * directory onto a file:
 *
 *   error mounting "/opt/chatcenter/scripts/authentik/custom.css" to rootfs at
 *   "/web/dist/custom.css": not a directory
 *
 * That surfaces at `up -d`, after the images are pulled, and reads like a
 * Docker bug rather than a missing file. It cost a production bring-up.
 *
 * So: whatever the compose file bind-mounts, push-deploy.sh must ship, and the
 * file must exist in the repo. Three lists that have to agree, asserted here
 * rather than remembered.
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
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Host paths the prod compose bind-mounts, e.g. `- ./scripts/x.css:/web/x.css:ro`. */
function composeBindMounts(): string[] {
  const compose = read("docker-compose.prod.yml");
  const hits = [...compose.matchAll(/^\s+- \.\/([^:\s]+):/gm)].map((m) => m[1]);
  return [...new Set(hits)].sort();
}

/** The asset list push-deploy.sh ships, read from the MOUNTED_ASSETS array. */
function scriptAssets(): string[] {
  const script = read("scripts/push-deploy.sh");
  const block = /MOUNTED_ASSETS=\(([^)]*)\)/.exec(script);
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .sort();
}

describe("production deploy: bind-mounted host files", () => {
  const mounts = composeBindMounts();

  it("finds the bind mounts in docker-compose.prod.yml", () => {
    expect(mounts.length).toBeGreaterThan(0);
  });

  it("every bind-mounted file exists in the repo", () => {
    const missing = mounts.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(missing, "compose mounts a path that does not exist here").toEqual([]);
  });

  it("push-deploy.sh ships every file the compose file mounts", () => {
    const shipped = new Set(scriptAssets());
    const unshipped = mounts.filter((f) => !shipped.has(f));
    expect(
      unshipped,
      "these are mounted but never sent to the box - Docker will create an empty directory and refuse to start",
    ).toEqual([]);
  });

  it("push-deploy.sh does not ship files nothing mounts", () => {
    const mounted = new Set(mounts);
    const stale = scriptAssets().filter((f) => !mounted.has(f));
    expect(stale, "dead entries in MOUNTED_ASSETS").toEqual([]);
  });
});
