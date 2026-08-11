/**
 * Path normalization, and the tour-arrival check built on it.
 *
 * The production build (`NEXT_OUTPUT=export`) sets `trailingSlash: true`;
 * development does not. So the same navigation yields "/conversations/" in
 * production and "/conversations" in development, and every
 * `pathname === "/conversations"` in the app is quietly false in production
 * only. In the guided tour that comparison decides whether the user has
 * arrived on a step's page, and while it says no, the tour holds an invisible
 * full-screen click-blocker with no popup behind it. The first customer to
 * follow the tour's "click Inbox" instruction on production got a dead app.
 *
 * Verified against the live production bundle: /conversations/ freezes,
 * /conversations does not.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizePath, samePath, isUnder } from "../pathname";
import { stepArrived, ALL_STEPS } from "@/components/onboarding/GuidedTour";

describe("normalizePath", () => {
  it("strips a trailing slash", () => {
    expect(normalizePath("/conversations/")).toBe("/conversations");
    expect(normalizePath("/ai-studio/")).toBe("/ai-studio");
    expect(normalizePath("/settings/channels/")).toBe("/settings/channels");
  });

  it("leaves the root alone", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath(null)).toBe("/");
    expect(normalizePath(undefined)).toBe("/");
  });

  it("is idempotent and tolerant of repeats", () => {
    expect(normalizePath(normalizePath("/x/"))).toBe("/x");
    expect(normalizePath("/x///")).toBe("/x");
  });

  it("drops query and hash if a whole href is passed in", () => {
    expect(normalizePath("/ai-studio/?tab=tools")).toBe("/ai-studio");
    expect(normalizePath("/legal/#terms")).toBe("/legal");
  });
});

describe("samePath", () => {
  it("treats the production and development shapes as one route", () => {
    expect(samePath("/conversations/", "/conversations")).toBe(true);
    expect(samePath("/conversations", "/conversations/")).toBe(true);
  });

  it("still tells different routes apart", () => {
    expect(samePath("/conversations", "/contacts")).toBe(false);
    expect(samePath("/settings", "/settings/channels")).toBe(false);
  });
});

describe("isUnder", () => {
  it("matches the route itself and its children", () => {
    expect(isUnder("/settings/", "/settings")).toBe(true);
    expect(isUnder("/settings/channels/", "/settings")).toBe(true);
  });

  it("does not match a route that merely shares a prefix", () => {
    expect(isUnder("/settings-extra", "/settings")).toBe(false);
  });
});

describe("stepArrived", () => {
  const none = new URLSearchParams();

  it("accepts the trailing-slash path production actually produces", () => {
    expect(stepArrived("/conversations", "/conversations/", none)).toBe(true);
    expect(stepArrived("/conversations", "/conversations", none)).toBe(true);
  });

  it("still refuses a different page", () => {
    expect(stepArrived("/conversations", "/contacts/", none)).toBe(false);
  });

  it("matches a step's query on the normalized path", () => {
    expect(stepArrived("/ai-studio?tab=tools", "/ai-studio/", new URLSearchParams("tab=tools"))).toBe(true);
    expect(stepArrived("/ai-studio?tab=tools", "/ai-studio/", new URLSearchParams("tab=knowledge"))).toBe(false);
    expect(stepArrived("/ai-studio?tab=tools", "/ai-studio/", none)).toBe(false);
  });

  it("ignores extra params the app adds of its own accord", () => {
    expect(
      stepArrived("/ai-studio?tab=tools", "/ai-studio/", new URLSearchParams("tab=tools&id=abc")),
    ).toBe(true);
  });

  it("a step with no navigateTo has always arrived", () => {
    expect(stepArrived(undefined, "/anywhere/", none)).toBe(true);
  });

  /**
   * The regression itself: run every real step against the path shape the
   * production build produces. Before the fix, every one of these was false,
   * and each false is a frozen app.
   */
  it("every real tour step arrives against a trailing-slash production path", () => {
    const withNav = ALL_STEPS.filter((s) => s.navigateTo);
    expect(withNav.length).toBeGreaterThan(0);
    for (const s of withNav) {
      const [p, q] = s.navigateTo!.split("?");
      const prodPathname = p.endsWith("/") ? p : `${p}/`;
      expect(stepArrived(s.navigateTo, prodPathname, new URLSearchParams(q || ""))).toBe(true);
    }
  });
});

/**
 * A source guard, in the spirit of static-export-dynamic-routes.test.ts: the
 * development stack cannot show you this class of bug, because `next dev` does
 * not add the trailing slash. This is the only place it can be caught before a
 * customer finds it.
 */
describe("no exact pathname comparisons in app code", () => {
  const SRC = path.resolve(__dirname, "../..");
  const ALLOWED = ["lib/pathname.ts"];

  function walk(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        walk(full, acc);
      } else if (/\.tsx?$/.test(e.name)) {
        acc.push(full);
      }
    }
    return acc;
  }

  it("compares routes through samePath/isUnder, never === against a literal", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (ALLOWED.some((a) => rel.endsWith(a))) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\bpathname\s*[!=]==\s*["'`]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
