/**
 * The channel card and the API must describe an import the same way.
 *
 * The frontend is not an npm workspace and cannot import `@chatcenter/shared`
 * at runtime, so the stage mapping exists twice and this test is what keeps the
 * two copies equal. Same convention as the embedded-signup version parity test.
 *
 * What a drift would look like in production: the API classifies an import as
 * `analyzing` and returns `percent: null`, while the frontend copy still thinks
 * that status is `transferring` and renders a bar at whatever the last source
 * percentage was. The customer sees a progress bar frozen at 100% forever, with
 * no error anywhere, because both halves are behaving exactly as written.
 *
 * The behaviour is compared rather than the source text: a copy that is
 * formatted differently but decides identically is fine, and one that reads
 * identically but has a member missing from a set is not.
 */
import { describe, it, expect } from "vitest";
import {
  historicalImportStage,
  historicalImportPercent,
  historicalAnalysisCounts,
  historicalAnalysisPercent,
  hasHistoricalResults,
  isHistoricalImportTerminal,
  HISTORICAL_SOURCE_WINDOW_DAYS,
  type HistoricalImportStatus,
} from "../historical-import-client";

const ALL_STATUSES: HistoricalImportStatus[] = [
  "NOT_AVAILABLE",
  "PENDING",
  "SOURCE_SYNCING",
  "SOURCE_COMPLETE",
  "INGESTING",
  "IDENTITY_RESOLUTION",
  "CUSTOMER_LEARNING",
  "KNOWLEDGE_EXTRACTION",
  "KNOWLEDGE_CLUSTERING",
  "ANALYTICS",
  "REVIEW_READY",
  "COMPLETED",
  "FAILED",
];

describe("the client mirror matches the shared original", () => {
  it("uses the same analysis progress bands as the shared helper", async () => {
    const { readFileSync } = await import("fs");
    const shared = readFileSync("../packages/shared/src/lib/historical-import.ts", "utf8");

    // The bands decide what percentage the customer sees. If the two copies
    // disagree, the bar jumps whenever the API and the client disagree about
    // which stage it is - so compare the numbers, not the prose around them.
    const block = shared.match(/const ANALYSIS_BANDS[\s\S]*?\n\];/);
    expect(block, "ANALYSIS_BANDS not found in the shared helper").toBeTruthy();
    // exec-loop rather than [...matchAll()]: the frontend tsconfig targets a
    // level where spreading an iterator needs --downlevelIteration, and the
    // whole point of this file is that it compiles under the FRONTEND config.
    const bandRe = /status: "(\w+)", from: (\d+), to: (\d+)/g;
    const sharedBands: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = bandRe.exec(block![0])) !== null) {
      sharedBands.push(`${m[1]}:${m[2]}-${m[3]}`);
    }
    expect(sharedBands.length).toBeGreaterThan(0);

    for (const entry of sharedBands) {
      const [status, range] = entry.split(":");
      const [from, to] = range.split("-").map(Number);
      // Floor of the band: nothing measured yet inside this stage.
      expect(
        historicalAnalysisPercent({
          status: status as HistoricalImportStatus,
          customersAnalyzed: 0,
          customersTotal: 0,
          conversationsExtracted: 0,
          conversationsEligible: 0,
        }),
        `${status} floor`,
      ).toBe(from);
      // Ceiling: the stage's measured work is complete.
      expect(
        historicalAnalysisPercent({
          status: status as HistoricalImportStatus,
          customersAnalyzed: 10,
          customersTotal: 10,
          conversationsExtracted: 10,
          conversationsEligible: 10,
        }),
        `${status} ceiling`,
      ).toBe(status === "CUSTOMER_LEARNING" || status === "KNOWLEDGE_EXTRACTION" ? to : from);
    }
  });

  it("reports no analysis percentage outside the analyzing stage", () => {
    for (const status of ALL_STATUSES) {
      const percent = historicalAnalysisPercent({
        status,
        customersAnalyzed: 5,
        customersTotal: 10,
        conversationsExtracted: 5,
        conversationsEligible: 10,
      });
      if (historicalImportStage(status) === "analyzing") {
        expect(percent, status).not.toBeNull();
      } else {
        expect(percent, status).toBeNull();
      }
    }
  });

  it("moves the bar only as measured work completes", () => {
    const at = (customersAnalyzed: number) =>
      historicalAnalysisPercent({
        status: "CUSTOMER_LEARNING",
        customersAnalyzed,
        customersTotal: 100,
        conversationsExtracted: 0,
        conversationsEligible: 0,
      });
    expect(at(0)).toBe(15);
    expect(at(50)).toBe(33);
    expect(at(100)).toBe(50);
    // A count beyond the total cannot push the bar past its band.
    expect(at(500)).toBe(50);
  });

  it("declares every status the Prisma enum declares", async () => {
    const { readFileSync } = await import("fs");
    const schema = readFileSync("../packages/shared/prisma/schema.prisma", "utf8");
    const block = schema.match(/enum HistoricalImportStatus \{([\s\S]*?)\n\}/);
    expect(block, "HistoricalImportStatus enum not found in schema.prisma").toBeTruthy();

    const fromSchema = block![1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Z_]+$/.test(l));

    expect([...fromSchema].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("maps every status to the same stage the shared helper does", async () => {
    const { readFileSync } = await import("fs");
    const shared = readFileSync("../packages/shared/src/lib/historical-import.ts", "utf8");

    // The shared file is TypeScript this test cannot import, so the ANALYZING
    // set is read out of it and the two decisions are compared directly. That
    // is the whole contract: which statuses mean "we are thinking".
    const setBlock = shared.match(
      /const ANALYZING: ReadonlySet<HistoricalImportStatus> = new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(setBlock, "ANALYZING set not found in the shared helper").toBeTruthy();
    // Deliberately not `[...matchAll()]`: the frontend tsconfig target rejects
    // spreading a RegExpStringIterator, and this file is typechecked with it.
    const sharedAnalyzing = new Set<string>(
      (setBlock![1].match(/"[A-Z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")),
    );

    for (const status of ALL_STATUSES) {
      const expected =
        status === "NOT_AVAILABLE"
          ? "unavailable"
          : status === "FAILED"
            ? "failed"
            : status === "REVIEW_READY" || status === "COMPLETED"
              ? "ready"
              : sharedAnalyzing.has(status)
                ? "analyzing"
                : "transferring";
      expect(historicalImportStage(status), `stage for ${status}`).toBe(expected);
    }
  });

  it("uses the same source window the shared helper does", async () => {
    const { readFileSync } = await import("fs");
    const shared = readFileSync("../packages/shared/src/lib/historical-import.ts", "utf8");
    const m = shared.match(/HISTORICAL_SOURCE_WINDOW_DAYS = (\d+)/);
    expect(m).toBeTruthy();
    expect(HISTORICAL_SOURCE_WINDOW_DAYS).toBe(Number(m![1]));
  });
});

describe("progress is only ever shown when it is honest", () => {
  it("shows the source percentage while history is transferring", () => {
    expect(historicalImportPercent({ status: "SOURCE_SYNCING", sourceProgress: 72 })).toBe(72);
  });

  it("shows NO percentage while analyzing, however far along it is", () => {
    // The point of the whole design: there is no measurable percentage for
    // "understanding your customers", and inventing one to keep a bar moving
    // makes every honest number on the page less believable.
    for (const status of [
      "SOURCE_COMPLETE",
      "INGESTING",
      "IDENTITY_RESOLUTION",
      "CUSTOMER_LEARNING",
      "KNOWLEDGE_EXTRACTION",
      "KNOWLEDGE_CLUSTERING",
      "ANALYTICS",
    ] as HistoricalImportStatus[]) {
      expect(historicalImportPercent({ status, sourceProgress: 100 }), status).toBeNull();
    }
  });

  it("clamps a source that reports nonsense", () => {
    expect(historicalImportPercent({ status: "SOURCE_SYNCING", sourceProgress: 250 })).toBe(100);
    expect(historicalImportPercent({ status: "SOURCE_SYNCING", sourceProgress: -5 })).toBe(0);
  });

  it("counts real work during analysis instead", () => {
    expect(
      historicalAnalysisCounts({
        status: "CUSTOMER_LEARNING",
        customersAnalyzed: 842,
        customersTotal: 1247,
      }),
    ).toEqual({ analyzed: 842, total: 1247 });
  });

  it("shows no counter before there is anything to count", () => {
    expect(
      historicalAnalysisCounts({
        status: "CUSTOMER_LEARNING",
        customersAnalyzed: 0,
        customersTotal: 0,
      }),
    ).toBeNull();
  });

  it("never reports more analyzed than exist", () => {
    expect(
      historicalAnalysisCounts({
        status: "CUSTOMER_LEARNING",
        customersAnalyzed: 9999,
        customersTotal: 10,
      }),
    ).toEqual({ analyzed: 10, total: 10 });
  });
});

describe("the results entry point appears only when there are results", () => {
  it("is hidden until the pipeline has finished", () => {
    for (const status of [
      "PENDING",
      "SOURCE_SYNCING",
      "SOURCE_COMPLETE",
      "CUSTOMER_LEARNING",
      "ANALYTICS",
      "FAILED",
      "NOT_AVAILABLE",
    ] as HistoricalImportStatus[]) {
      expect(hasHistoricalResults(status), status).toBe(false);
    }
  });

  it("appears once results are reviewable", () => {
    expect(hasHistoricalResults("REVIEW_READY")).toBe(true);
    expect(hasHistoricalResults("COMPLETED")).toBe(true);
  });
});

describe("a declined import is not a failed one", () => {
  it("reads as unavailable rather than failed", () => {
    // The business switched history sharing off in their app. Showing a red
    // failure would blame us for their choice and push them to "fix" something
    // that is not broken.
    expect(historicalImportStage("NOT_AVAILABLE")).toBe("unavailable");
    expect(historicalImportStage("FAILED")).toBe("failed");
  });

  it("is terminal, like the other two end states", () => {
    expect(isHistoricalImportTerminal("NOT_AVAILABLE")).toBe(true);
    expect(isHistoricalImportTerminal("COMPLETED")).toBe(true);
    expect(isHistoricalImportTerminal("FAILED")).toBe(true);
    expect(isHistoricalImportTerminal("CUSTOMER_LEARNING")).toBe(false);
  });
});
