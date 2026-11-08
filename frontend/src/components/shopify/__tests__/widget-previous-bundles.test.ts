/**
 * An old bootstrap (an installed theme's ?b=, an edge cache) names the hashed
 * bundle it was built with, for hours after a new build. That file must stay
 * served, or the chat 404s on live stores (2026-11-08: a5def87598f3 replaced
 * fd5d86cae08b, which cached bootstrap 3695cc8212d0 still loads).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../public/widget");
const manifest = JSON.parse(readFileSync(join(DIR, "widget-manifest.json"), "utf8"));
const script = readFileSync(join(__dirname, "../../../../../scripts/widget/build-widget.mjs"), "utf8");

describe("previous widget bundles stay served", () => {
  it("every bundle the manifest keeps is on disk, and its bytes match its name", () => {
    const kept = [...(manifest.previous?.chat ?? []), ...(manifest.previous?.site ?? [])];
    expect(kept).toContain("gotcha-shopify-chat.fd5d86cae08b.js");
    for (const f of kept) {
      expect(existsSync(join(DIR, f))).toBe(true);
      const hash = createHash("sha256").update(readFileSync(join(DIR, f))).digest("hex").slice(0, 12);
      expect(f).toContain(hash);
    }
  });
  it("the build deletes only bundles beyond the kept ones, and --check fails on a missing one", () => {
    expect(script).toContain("const keep = new Set([chatName, siteName, ...previous.chat, ...previous.site]);");
    expect(script).toContain("!keep.has(f)");
    expect(script).toContain("a previous bundle an old bootstrap may still load is missing");
    expect(script).not.toMatch(/f !== chatName\) \|\|/);
  });
});
