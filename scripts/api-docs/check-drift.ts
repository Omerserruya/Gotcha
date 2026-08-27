/**
 * Fail if the committed API docs no longer match the source.
 *
 * This is the part that makes the documentation maintainable rather than
 * merely accurate on the day it was written. Regenerating into a temp
 * location and diffing turns "the docs are stale" from something nobody
 * notices into a build failure with a list of what changed.
 *
 * Intended for CI:  npm run api:docs:check
 * Exit 0 = in sync. Exit 1 = regenerate with `npm run api:docs` and commit.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const ARTIFACTS = ["docs/openapi.yaml", "docs/API_EXECUTION_MAP.md"];

function run(script: string): void {
  execFileSync("npx", ["tsx", path.join(__dirname, script)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function main(): void {
  const backup = new Map<string, string | null>();
  for (const rel of ARTIFACTS) {
    const abs = path.join(REPO_ROOT, rel);
    backup.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);
  }

  // Regenerate in place, compare, then restore whatever was committed so the
  // check never mutates the working tree - a verification step that edits the
  // thing it verifies is a trap for whoever runs it locally.
  try {
    run("extract-routes.ts");
    run("generate-openapi.ts");
    run("generate-execution-map.ts");

    const drifted: string[] = [];
    for (const rel of ARTIFACTS) {
      const fresh = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      if (backup.get(rel) !== fresh) drifted.push(rel);
    }

    if (drifted.length === 0) {
      console.log("API docs are in sync with the source.");
      return;
    }

    console.error("API docs are OUT OF DATE with the source:\n");
    for (const rel of drifted) {
      const before = backup.get(rel);
      const fresh = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const b = before === null ? 0 : before.split("\n").length;
      const a = fresh.split("\n").length;
      console.error(`  ${rel}  (${b} → ${a} lines)`);
    }
    console.error("\nRegenerate and commit:\n  npm run api:docs\n");
    process.exitCode = 1;
  } finally {
    for (const [rel, content] of backup) {
      const abs = path.join(REPO_ROOT, rel);
      if (content === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, content);
    }
  }
}

main();
