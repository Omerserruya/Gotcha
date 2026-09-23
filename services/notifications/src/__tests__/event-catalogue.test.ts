import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { EVENT_CATALOGUE, DECLARATION_ONLY_FILES, buildCatalogue } from "../services/event-catalogue";
import { DELIVERABLE_CHANNELS } from "../services/notification-engine.service";

/**
 * The catalogue's `emitted` flag is hand-maintained because it cannot be
 * computed - see the header of event-catalogue.ts for the four methods that
 * each got a different wrong answer.
 *
 * So this checks the EVIDENCE instead, in both directions. It is the whole
 * reason the flag is trustworthy: a hand-maintained list nobody re-checks
 * becomes folklore, which is exactly what the frontend's old list was.
 */
const REPO = join(__dirname, "..", "..", "..", "..");

describe("notification event catalogue", () => {
  it("is non-empty - a parse failure must not pass silently", () => {
    expect(EVENT_CATALOGUE.length).toBeGreaterThan(10);
  });

  it("has no duplicate keys", () => {
    const keys = EVENT_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("every emitted:true entry still has its emitter", () => {
    for (const entry of EVENT_CATALOGUE.filter((e) => e.emitted)) {
      it(`${entry.key}`, () => {
        expect(entry.emitters.length, `${entry.key} claims emitted with no evidence`).toBeGreaterThan(0);
        for (const ref of entry.emitters) {
          const path = join(REPO, ref.file);
          expect(existsSync(path), `${entry.key}: recorded emitter file is gone: ${ref.file}`).toBe(true);
          const src = readFileSync(path, "utf-8");
          expect(
            src.includes(`"${entry.key}"`),
            `${entry.key}: ${ref.file} no longer mentions it - the emitter moved or was deleted`,
          ).toBe(true);
          expect(
            src.includes(ref.via),
            `${entry.key}: ${ref.file} no longer contains "${ref.via}" - the emit mechanism changed`,
          ).toBe(true);
        }
      });
    }
  });

  describe("every emitted:false entry is still genuinely dead", () => {
    for (const entry of EVENT_CATALOGUE.filter((e) => !e.emitted)) {
      it(`${entry.key}`, () => {
        // -F, NOT a regex: a "." in an event key is a wildcard, and an
        // unescaped search for subscription.canceled matches
        // subscription_canceled. That produced one of the wrong answers.
        let hits: string[] = [];
        try {
          hits = execSync(
            `grep -rlF '"${entry.key}"' --include=*.ts services packages/shared/src || true`,
            { cwd: REPO, encoding: "utf-8" },
          )
            .split("\n")
            .filter(Boolean)
            .filter((f) => !f.includes("__tests__") && !f.includes("node_modules") && !f.includes("/scripts/"))
            .filter((f) => !DECLARATION_ONLY_FILES.some((d) => f === d));
        } catch {
          hits = [];
        }
        expect(
          hits,
          `${entry.key} is marked NOT emitted but is referenced outside the declaration files. ` +
            `If an emitter was added, set emitted:true and record it - a catalogue that marks a ` +
            `live event dead hides a control that works.`,
        ).toEqual([]);
      });
    }
  });

  it("offers only channels the dispatcher can deliver", () => {
    expect(buildCatalogue().channels).toEqual([...DELIVERABLE_CHANNELS]);
  });

  it("every caveat is a sentence, not a label", () => {
    for (const e of EVENT_CATALOGUE) {
      if (e.caveat) expect(e.caveat.length, `${e.key} caveat too short to be useful`).toBeGreaterThan(30);
    }
  });
});
