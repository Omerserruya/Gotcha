/**
 * Dynamic route segments under `output: export`.
 *
 * Our [id]/[slug] routes prerender ONE "_" placeholder and nginx serves every
 * real id from it, so the built flight payload binds the segment literally:
 *
 *     ["id","_","d"],{"children":["__PAGE__?{\"id\":\"_"
 *
 * `useParams().id` is therefore the string "_" for every id. A page that looks
 * its record up by that value finds nothing and reports the record as missing -
 * "That plan version no longer exists" for a plan sitting in the database.
 * Invisible in dev, where Next serves real dynamic routes.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveDynamicParam } from "../useRouteParam";

const call = (o: Partial<Parameters<typeof resolveDynamicParam>[0]>) =>
  resolveDynamicParam({ name: "id", fromParams: undefined, pathname: null, ...o });

describe("resolveDynamicParam", () => {
  it("trusts a real param (dev, and routes with prerendered params)", () => {
    expect(call({ fromParams: "abc123", pathname: "/system/plans/abc123/" })).toBe("abc123");
  });

  it("recovers the id from the URL when the param is the placeholder", () => {
    expect(call({ fromParams: "_", pathname: "/system/plans/cmsd9haw5009ovsxfjj5qnjva/" }))
      .toBe("cmsd9haw5009ovsxfjj5qnjva");
  });

  it("recovers it when the param is absent entirely", () => {
    expect(call({ pathname: "/system/plans/abc123/" })).toBe("abc123");
  });

  /**
   * The reason `pattern` exists. `/settings/voice-channels/<id>/routing` ends in
   * "routing", so the last-segment shortcut returns "routing" as the channel id -
   * wrong, and wrong QUIETLY: it fetches a real endpoint with a plausible string.
   */
  it("reads the right segment when the dynamic one is not last", () => {
    const pathname = "/settings/voice-channels/chan_42/routing/";
    expect(call({ fromParams: "_", pathname, pattern: "/settings/voice-channels/[id]/routing" }))
      .toBe("chan_42");
    // Without the pattern the same URL yields the trailing literal.
    expect(call({ fromParams: "_", pathname })).toBe("routing");
  });

  it("handles a two-segment-deep pattern", () => {
    expect(call({ fromParams: "_", pathname: "/departments/dep_7/copilot/", pattern: "/departments/[id]/copilot" }))
      .toBe("dep_7");
  });

  it("decodes percent-encoded segments", () => {
    expect(call({ name: "provider", fromParams: "_", pathname: "/settings/business-systems/my%20crm/" }))
      .toBe("my crm");
  });

  it("returns empty when the pattern does not contain the param", () => {
    expect(call({ fromParams: "_", pathname: "/system/plans/abc/", pattern: "/system/plans/[slug]" })).toBe("");
  });

  /** A placeholder in the URL too means there is genuinely nothing to resolve. */
  it("returns empty rather than the placeholder itself", () => {
    expect(call({ fromParams: "_", pathname: "/system/plans/_/" })).toBe("");
    expect(call({ fromParams: "_", pathname: "" })).toBe("");
    expect(call({ fromParams: "_", pathname: null })).toBe("");
  });

  it("takes the first value of a catch-all array param", () => {
    expect(call({ fromParams: ["real", "extra"], pathname: "/x/" })).toBe("real");
  });
});

/**
 * The class-level guard. A page under a placeholder route that reads
 * `useParams()` directly is reading "_" in production - the bug this module
 * exists to prevent, which shipped anyway because one page did not use it.
 */
describe("placeholder routes do not read useParams directly", () => {
  const APP = path.join(__dirname, "..", "..", "app");

  /** Route directories whose layout prerenders a single "_" placeholder. */
  function placeholderRouteDirs(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const d = path.join(dir, e.name);
        const layout = path.join(d, "layout.tsx");
        if (fs.existsSync(layout) && /:\s*"_"\s*\}/.test(fs.readFileSync(layout, "utf8"))) out.push(d);
        walk(d);
      }
    };
    walk(APP);
    return out;
  }

  it("every page under a '_' placeholder route uses useDynamicParam", () => {
    const offenders: string[] = [];
    for (const dir of placeholderRouteDirs()) {
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) { walk(f); continue; }
          if (!/\.tsx$/.test(e.name)) continue;
          const src = fs.readFileSync(f, "utf8");
          if (/\buseParams\s*(<[^>]*>)?\s*\(/.test(src)) {
            offenders.push(path.relative(APP, f));
          }
        }
      };
      walk(dir);
    }
    expect(
      offenders.sort(),
      "these read useParams() under a placeholder route, so they see \"_\" in production",
    ).toEqual([]);
  });
});
