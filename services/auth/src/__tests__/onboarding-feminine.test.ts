/**
 * ★ GOTCHA speaks of herself in the feminine (Hebrew): the onboarding progress
 * steps ("קוראת את קטלוג המוצרים", "מכינה את עובד ה-AI הראשון שלכם") are
 * GOTCHA at work, so their verbs are feminine. A source check: every Hebrew
 * step label in onboarding.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "..", "routes", "onboarding.ts"), "utf8");
// ["key", "English label", "Hebrew label"]
const STEPS = [...SOURCE.matchAll(/\["[a-z_]+", "[^"]+", "([^"]*[֐-׿][^"]*)"\]/g)].map((m) => m[1]!);

describe("★ onboarding steps speak in the feminine", () => {
  it("finds the steps it guards", () => {
    expect(STEPS.length).toBeGreaterThan(15);
  });

  it("no masculine verb", () => {
    const masculine = STEPS.filter((s) => /^(קורא|מכין|לומד|מוצא|מבין|בודק|כותב|מחפש|סורק|מנתח) /.test(s));
    expect(masculine).toEqual([]);
    expect(STEPS).toContain("קוראת את קטלוג המוצרים");
    expect(STEPS).toContain("מכינה את עובד ה-AI הראשון שלכם");
    expect(STEPS).toContain("לומדת את קול המותג שלכם");
    expect(STEPS).toContain("מוצאת את מדיניות המשלוח וההחזרות");
    expect(STEPS).toContain("מבינה את המוצר שלכם");
  });
});
