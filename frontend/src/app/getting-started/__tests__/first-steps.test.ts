/**
 * The first-steps page after the sandbox chat was taken off it.
 *
 * The page led with a chat against the AI employee, which took the top two
 * thirds of the layout. It was a rehearsal, not a first step: it completes
 * nothing, changes no readiness signal, and pushed the five actions that
 * actually take a workspace live into a narrow side column. Testing an
 * employee still exists - it lives in AI Studio, where the employee lives.
 *
 * What the page must NOT lose in the process is the canonical journey
 * contract: the same items, counts and completion rules the sidebar panel and
 * nav badge read, never recomputed locally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { nextAction } from "@/lib/first-steps";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const page = readFileSync(join(SRC, "app/getting-started/page.tsx"), "utf8");

describe("the sandbox chat is gone from first steps", () => {
  it("does not send messages to an agent from this page", () => {
    expect(page).not.toContain("testAgentChat");
    expect(page).not.toMatch(/setMessages|chatEndRef|setSending/);
  });

  it("drops the copy that only existed for the chat", () => {
    expect((en.gettingStarted as unknown as Record<string, unknown>).chat).toBeUndefined();
    expect((he.gettingStarted as unknown as Record<string, unknown>).chat).toBeUndefined();
  });

  it("no longer promises a conversation in the page subtitle", () => {
    // The old subtitle told owners to "talk to it" as the first step.
    expect(en.gettingStarted.subtitle).not.toMatch(/talk to it/i);
  });

  it("keeps the sandbox available where the employee lives", () => {
    // Removing it here must not delete the feature: AI Studio's TestChatModal
    // is still the place to rehearse against an employee.
    expect(existsSync(join(SRC, "components/TestChatModal.tsx"))).toBe(true);
  });
});

describe("the canonical journey contract survives the redesign", () => {
  it("still reads readiness from the shared journey store, not local guesses", () => {
    expect(page).toContain("subscribeJourney");
    expect(page).toContain("refreshJourney");
    expect(page).toContain("getCachedJourney");
  });

  it("still shows the server's own counts", () => {
    expect(page).toContain("journey?.summary?.done");
    expect(page).toContain("journey?.summary?.total");
  });

  it("still renders every milestone the server sends, with its own deep link", () => {
    expect(page).toContain("milestones.map(");
    expect(page).toContain("href={m.deepLink}");
  });

  it("keeps the skeleton and the retryable error state", () => {
    // A flash of "everything incomplete" is worse than a skeleton.
    expect(page).toContain("animate-pulse");
    expect(page).toContain("setupChecklist.retry");
  });
});

describe("nextAction picks the one thing to do now", () => {
  const step = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, done: false, state: "not_started", status: "idle", deepLink: `/${id}`, ...over }) as never;

  it("prefers a step that needs attention over anything else", () => {
    const chosen = nextAction([
      step("a", { status: "active" }),
      step("b", { state: "attention" }),
    ]);
    expect(chosen?.id).toBe("b");
  });

  it("otherwise takes the step the journey marks active", () => {
    expect(nextAction([step("a"), step("b", { status: "active" })])?.id).toBe("b");
  });

  it("otherwise prefers something already in progress over an untouched step", () => {
    expect(nextAction([step("a"), step("b", { state: "in_progress" })])?.id).toBe("b");
  });

  it("falls back to the first open step, keeping the server's order", () => {
    expect(nextAction([step("a"), step("b")])?.id).toBe("a");
  });

  it("never points at a completed step", () => {
    const chosen = nextAction([step("a", { done: true, status: "active" }), step("b")]);
    expect(chosen?.id).toBe("b");
  });

  it("returns nothing once everything is done, so the page can celebrate", () => {
    expect(nextAction([step("a", { done: true }), step("b", { done: true })])).toBeNull();
    expect(nextAction([])).toBeNull();
  });
});

describe("the finished state", () => {
  it("has copy in both languages and does not dead-end the owner", () => {
    for (const locale of [en, he]) {
      const gs = locale.gettingStarted as unknown as Record<string, string>;
      expect(gs.allDoneTitle?.length).toBeGreaterThan(0);
      expect(gs.allDoneBody?.length).toBeGreaterThan(0);
      expect(gs.allDoneCta?.length).toBeGreaterThan(0);
    }
    expect(page).toContain('href="/conversations"');
  });

  it("has the new progress and up-next copy in both languages", () => {
    for (const locale of [en, he]) {
      const gs = locale.gettingStarted as unknown as Record<string, string>;
      expect(gs.upNext?.length).toBeGreaterThan(0);
      expect(gs.progressCount).toContain("{done}");
      expect(gs.progressCount).toContain("{total}");
    }
  });
});

describe("house style", () => {
  it("uses no em or en dashes in the copy this page added", () => {
    // QUALITY_CONTRACT rule 11: an em-dash reads as machine-written.
    for (const locale of [en, he]) {
      const gs = locale.gettingStarted as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(gs)) {
        if (typeof value !== "string") continue;
        expect(value, `gettingStarted.${key}`).not.toMatch(/[—–]/);
      }
    }
  });
});
