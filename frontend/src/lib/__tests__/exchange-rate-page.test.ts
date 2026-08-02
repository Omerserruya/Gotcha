import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Sysadmin exchange-rate page against the contract it actually calls.
 *
 * These exist because of a specific break: the backend was changed to require a
 * `reason` on every manual override, the server tests were updated, and the form
 * that submits it was not. It kept posting `{ rate }` and every override
 * silently failed with 400 - a whole feature broken with a full green suite,
 * because nothing tested the two halves against each other.
 */
const page = readFileSync(
  join(__dirname, "../../app/system/exchange-rate/page.tsx"),
  "utf8",
);
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the override form matches what the server requires", () => {
  it("sends a reason", () => {
    expect(code).toContain("reason: reason.trim()");
  });

  it("will not submit without one", () => {
    // The server would reject it anyway; refusing here means the person is told
    // before they have entered a rate they think has taken effect.
    expect(code).toContain("!reason.trim()");
  });

  it("clears the reason after submitting", () => {
    // A reason left in the box gets reused for the next, unrelated override.
    expect(code).toContain("setReason(\"\")");
  });
});

describe("the page describes the system that exists", () => {
  it("does not claim the rate is never fetched", () => {
    // It said "entered by hand and never fetched" long after it began being
    // fetched automatically. A page that misdescribes the mechanism is worse
    // than one that says nothing: it is believed.
    expect(page).not.toContain("never fetched");
    expect(page).not.toContain("entered by hand and never");
  });

  it("names the source", () => {
    expect(page).toContain("Bank of Israel");
  });
});

describe("the feed panel", () => {
  it("reads the status endpoint", () => {
    expect(code).toContain("/api/admin/billing/fx-status");
  });

  it("can trigger a fetch", () => {
    expect(code).toContain("/api/admin/billing/fx-refresh");
  });

  it("distinguishes 'cannot tell' from 'healthy'", () => {
    // A failed status call must not render as a working feed.
    expect(code).toContain("could not find out");
  });

  it("says plainly when nothing can be charged", () => {
    expect(page).toContain("Nothing can be charged right now");
  });

  it("says when the rate in use is not the official one", () => {
    // Charging at an override is a fact someone needs to see without going
    // looking for it.
    expect(page).toContain("manual override, not the official rate");
  });

  it("explains an open circuit rather than showing a silent failure", () => {
    expect(code).toContain("circuitOpenUntil");
    expect(page).toContain("not being called again until");
  });
});
