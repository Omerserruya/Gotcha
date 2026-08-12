/**
 * The co-pilot panel has to say WHY it is unavailable, not just that it is.
 *
 * In production, tenant "Urban Supply" had a working, ACTIVE AI employee and a
 * plan whose `ai.copilot` entitlement was false. The endpoint is gated, so the
 * request was refused before any co-pilot code ran, the panel swallowed the
 * error with `.catch(() => null)`, and the empty state told the customer to go
 * and connect an AI employee they already had.
 *
 * Every failure collapsed into that one message: a plan denial, a provider
 * error, the org switching the co-pilot off, and even "I looked and had no
 * useful suggestion" all rendered "no AI employee configured".
 *
 * These assert against the source, because the branch that was wrong is the
 * mapping from failure to message rather than anything rendered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const src = readFileSync("src/components/conversations/CoPilotPanel.tsx", "utf8");

describe("the co-pilot keeps the reason it failed", () => {
  it("does not throw the error away", () => {
    // `.catch(() => null)` on the suggestions call is exactly how the plan
    // denial became invisible. apiFetch already attaches status/code/body.
    expect(src).not.toMatch(/getAISuggestions\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/);
    expect(src).toMatch(/suggestionsErr\.current = e/);
  });

  it("reads a plan denial as a plan denial", () => {
    expect(src).toMatch(/status === 402 \|\| code === "PLAN_FEATURE_REQUIRED"/);
    expect(src).toMatch(/setUnavailableReason\("plan"\)/);
  });

  it("separates a failure from a missing employee", () => {
    for (const reason of ['"plan"', '"disabled"', '"error"', '"no_employee"']) {
      expect(src, `${reason} must be a distinct reason`).toContain(`setUnavailableReason(${reason})`);
    }
  });

  it("does not treat every single info item as a broken setup", () => {
    // "no-match" means the co-pilot looked and had nothing to add. Calling that
    // a configuration problem told people to reconfigure a working product.
    expect(src).not.toMatch(/const isStub = suggestionsRes\.data\.length === 1/);
    expect(src).toMatch(/only === "no-config"/);
    expect(src).toMatch(/only === "disabled"/);
    expect(src).toMatch(/only === "error"/);
  });
});

describe("each reason leads somewhere that helps", () => {
  it("sends a plan denial to the plans page, not to the employee builder", () => {
    expect(src).toMatch(/unavailableReason === "plan"\s*\?\s*"\/settings\/billing\/plan"/);
  });

  it("offers no button for a transient failure", () => {
    // There is nowhere useful to send someone whose provider call just failed,
    // and a button that goes somewhere irrelevant is worse than none.
    expect(src).toMatch(/unavailableReason !== "error" && \(/);
  });

  it("still offers the builder when there genuinely is no employee", () => {
    expect(src).toMatch(/"\/ai-studio"/);
    expect(src).toMatch(/copilot\.panel\.noAiEmployee\.setupButton/);
  });
});

describe("the copy exists in both languages", () => {
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const he = JSON.parse(readFileSync("src/i18n/he.json", "utf8"));

  it("has every new string in en and he", () => {
    for (const [group, keys] of [
      ["planRequired", ["title", "description", "button"]],
      ["disabled", ["title", "description", "button"]],
      ["failed", ["title", "description"]],
    ] as Array<[string, string[]]>) {
      for (const k of keys) {
        expect(en.copilot.panel[group]?.[k], `en copilot.panel.${group}.${k}`).toBeTruthy();
        expect(he.copilot.panel[group]?.[k], `he copilot.panel.${group}.${k}`).toBeTruthy();
      }
    }
  });

  it("tells a plan-gated customer their employee is fine", () => {
    // The failure mode was making someone doubt a setup that was correct.
    expect(en.copilot.panel.planRequired.description.toLowerCase()).toContain("working");
    expect(he.copilot.panel.planRequired.description).toContain("פועל");
  });
});
