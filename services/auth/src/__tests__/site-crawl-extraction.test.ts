/**
 * CONTROL for lifting the crawler out of `routes/onboarding.ts`.
 *
 * The risk in this refactor is not that the diff looks wrong - it is that the
 * onboarding flow reads its own scan results from this code path, so a silent
 * change lands on every new tenant rather than on a screen somebody is
 * watching. "Obviously cannot change behaviour" is the description of the
 * refactors that do.
 *
 * So the golden file in `fixtures/site-crawl-golden.json` was CAPTURED FROM THE
 * PRE-EXTRACTION CODE: the helpers were temporarily exported from
 * `onboarding.ts` and driven through the route's own orchestration, on the
 * fixture site, before a line was moved. This test asserts the extracted
 * `crawlSite` reproduces it exactly. Nothing here was written by reading the
 * new implementation.
 *
 * It runs offline. `safeFetch` blocks private and loopback addresses by design,
 * so a fixture server is impossible and the page fetcher is injected instead -
 * which is also what makes the assertions cover the parts that could drift:
 * which URLs are requested, the dedupe, the cap, and the per-page slicing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crawlSite, CRAWL_FETCH_CAP } from "../services/site-crawl.service";
import { ORIGIN, makeFetcher } from "./fixtures/site-crawl-fixture";

const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "site-crawl-golden.json"), "utf8"),
) as {
  discovered: string[];
  toFetch: string[];
  pages: Array<{ url: string; text: string }>;
  signals: Record<string, unknown>;
  businessType: string;
};

async function run() {
  const { fetchPage, requested } = makeFetcher();
  const crawl = await crawlSite(ORIGIN, { fetchPage });
  if (!crawl) throw new Error("crawl returned null on the fixture site");
  return { crawl, requested };
}

describe("the extracted crawler reproduces the pre-extraction behaviour", () => {
  it("asks for exactly the same URLs, in the same order", async () => {
    const { requested } = await run();

    // The home page first, then the deduped discovered-plus-candidate set.
    expect(requested).toEqual([ORIGIN, ...GOLDEN.toFetch]);
  });

  it("sends the same pages, with the same text, to the AI service", async () => {
    const { crawl } = await run();

    // Byte-for-byte: the 9000/2800 slices are part of the contract, because
    // the AI service's body-parser limit is what they exist to respect.
    expect(crawl.pages).toEqual(GOLDEN.pages);
  });

  it("extracts the same signals", async () => {
    const { crawl } = await run();

    // Includes emailProviders: the fixture's addresses are on a reserved
    // `.invalid` domain, so the real DNS path runs and deterministically
    // finds nothing, rather than being stubbed out of the comparison.
    expect(crawl.signals).toEqual(GOLDEN.signals);
  });

  it("classifies the business the same way", async () => {
    const { crawl } = await run();

    expect(crawl.businessType).toBe(GOLDEN.businessType);
  });
});

describe("what the crawl owns, and must keep owning", () => {
  it("follows same-origin policy and info links, and ignores the rest", async () => {
    const { requested } = await run();

    expect(requested).toContain(`${ORIGIN}/pages/about`);
    expect(requested).toContain(`${ORIGIN}/policies/refund-policy`);
    // Offsite links are never followed - the crawl is same-origin.
    expect(requested.some((u) => u.includes("elsewhere.example.org"))).toBe(false);
    // A link with no policy/info keyword is not worth a fetch.
    expect(requested).not.toContain(`${ORIGIN}/blog/not-interesting`);
  });

  it("caps the fetches and never re-requests the origin", async () => {
    const { requested } = await run();

    // The cap lives WITH the crawler, not at the route: a caller that had to
    // apply it could apply a different one and still look correct.
    expect(requested.length).toBe(1 + CRAWL_FETCH_CAP);
    expect(requested.filter((u) => u === ORIGIN)).toHaveLength(1);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it("returns null when the home page cannot be read, rather than an empty crawl", async () => {
    // The caller decides what that means - onboarding fails the scan, while a
    // rescan may leave the previous answer standing. An empty-but-successful
    // crawl would let a rescan report "we found nothing on your site".
    const crawl = await crawlSite(ORIGIN, { fetchPage: async () => null });

    expect(crawl).toBeNull();
  });

  it("reports its phases in order, and a failing reporter cannot break the crawl", async () => {
    const { fetchPage } = makeFetcher();
    const seen: string[] = [];

    const crawl = await crawlSite(ORIGIN, {
      fetchPage,
      onPhase: (p) => {
        seen.push(p);
        // Onboarding's reporter writes to the database. A narration failure
        // must never cost the crawl that was already paid for.
        throw new Error("narration exploded");
      },
    });

    expect(seen).toEqual(["homepage", "pages", "signals"]);
    expect(crawl).not.toBeNull();
  });
});
