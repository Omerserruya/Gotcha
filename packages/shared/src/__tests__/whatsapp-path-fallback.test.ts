/**
 * Recovering from the un-guessable Embedded Signup path choice.
 *
 * Meta requires the flow to be chosen BEFORE authorization, and the field that
 * says which was right (`is_on_biz_app`) is only readable AFTER it. So a wrong
 * guess is not a user error, it is a structural certainty. Every case here is
 * a way the customer could otherwise be left staring at an empty list with no
 * idea what to do next.
 */
import { describe, it, expect } from "vitest";
import { evaluatePathOutcome, otherPath, type PathCandidate } from "../whatsapp";

const onBusinessApp: PathCandidate = { usesBusinessApp: true, scenario: "COEXISTENCE" };
const plainCloud: PathCandidate = { usesBusinessApp: false, scenario: "EXISTING_CLOUD_API" };
const ours: PathCandidate = { usesBusinessApp: false, alreadyConnectedHere: true, scenario: "RECONNECT" };
const blocked: PathCandidate = { usesBusinessApp: false, scenario: "BLOCKED" };

describe("otherPath", () => {
  it("pairs the two flows", () => {
    expect(otherPath("new")).toBe("business-app");
    expect(otherPath("business-app")).toBe("new");
  });
});

describe("standard flow with nothing to connect", () => {
  it("sends the customer to the Business app flow when Meta returned nothing", () => {
    // A number already living in the WhatsApp Business app does not surface in
    // the standard flow at all, so "no results" is itself the clue.
    const outcome = evaluatePathOutcome("new", []);
    expect(outcome.switchTo).toBe("business-app");
    expect(outcome.reason).toBe("NO_CANDIDATES");
    expect(outcome.eligibleCount).toBe(0);
  });

  it("still connects a Coexistence number that the standard flow surfaced", () => {
    // Counter-intuitive but correct: if a number with is_on_biz_app=true
    // appears in the STANDARD flow, it is already on Cloud API, so it was
    // onboarded to Coexistence at some earlier point. The flow selector routes
    // it to COEXISTENCE and skips registration. Treating it as ineligible and
    // sending the customer round the Business app loop would block a
    // connection that works perfectly well.
    const outcome = evaluatePathOutcome("new", [onBusinessApp]);
    expect(outcome.reason).toBe("OK");
    expect(outcome.eligibleCount).toBe(1);
    expect(outcome.switchTo).toBeNull();
  });

  it("does not suggest a relaunch when every number found is blocked", () => {
    // Their blockers are shown per candidate and none is fixed by starting
    // over in the other flow.
    const outcome = evaluatePathOutcome("new", [blocked, blocked]);
    expect(outcome.reason).toBe("ALL_BLOCKED");
    expect(outcome.switchTo).toBeNull();
  });

  it("does not suggest switching when the numbers are simply already ours", () => {
    // Re-authorising down the other path reaches the same numbers, so
    // offering it would waste the customer's time and confuse them.
    const outcome = evaluatePathOutcome("new", [ours, ours]);
    expect(outcome.switchTo).toBeNull();
    expect(outcome.reason).toBe("ALL_ALREADY_CONNECTED");
  });
});

describe("Business app flow with nothing eligible", () => {
  it("sends the customer back to the standard flow when nothing is on the Business app", () => {
    const outcome = evaluatePathOutcome("business-app", [plainCloud]);
    expect(outcome.switchTo).toBe("new");
    expect(outcome.reason).toBe("NO_BUSINESS_APP_NUMBER");
  });

  it("sends the customer back to the standard flow when Meta returned nothing", () => {
    const outcome = evaluatePathOutcome("business-app", []);
    expect(outcome.switchTo).toBe("new");
    expect(outcome.reason).toBe("NO_CANDIDATES");
  });

  it("refuses to treat a non-Business-app number as eligible", () => {
    // Connecting a plain Cloud API number through the Coexistence flow would
    // onboard the wrong thing through the wrong door.
    const outcome = evaluatePathOutcome("business-app", [plainCloud, plainCloud]);
    expect(outcome.eligibleCount).toBe(0);
  });
});

describe("when there IS something to connect", () => {
  it("stays put on the standard flow", () => {
    const outcome = evaluatePathOutcome("new", [plainCloud]);
    expect(outcome.reason).toBe("OK");
    expect(outcome.switchTo).toBeNull();
    expect(outcome.eligibleCount).toBe(1);
  });

  it("stays put on the Business app flow", () => {
    const outcome = evaluatePathOutcome("business-app", [onBusinessApp]);
    expect(outcome.reason).toBe("OK");
    expect(outcome.switchTo).toBeNull();
  });

  it("counts only what is genuinely connectable", () => {
    // Blocked and already-ours numbers are shown, but they are not reasons to
    // call the flow a success.
    const outcome = evaluatePathOutcome("new", [plainCloud, ours, blocked]);
    expect(outcome.eligibleCount).toBe(1);
    expect(outcome.reason).toBe("OK");
  });

  it("does not call a flow successful when every number found is blocked", () => {
    const outcome = evaluatePathOutcome("new", [blocked]);
    expect(outcome.eligibleCount).toBe(0);
    expect(outcome.reason).not.toBe("OK");
  });
});

describe("never a bare empty state", () => {
  it("always produces a reason the UI can explain", () => {
    const cases: Array<[("new" | "business-app"), PathCandidate[]]> = [
      ["new", []],
      ["new", [onBusinessApp]],
      ["new", [ours]],
      ["new", [blocked]],
      ["business-app", []],
      ["business-app", [plainCloud]],
      ["business-app", [ours]],
      ["business-app", [onBusinessApp]],
    ];
    for (const [path, candidates] of cases) {
      const outcome = evaluatePathOutcome(path, candidates);
      expect(outcome.reason, `${path} / ${candidates.length} candidates`).toBeTruthy();
      expect(outcome.path).toBe(path);
    }
  });
});
