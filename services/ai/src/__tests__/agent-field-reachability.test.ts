import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Which AIAgent fields actually change what the AI does.
 *
 * The model has ~40 columns. Several were accepted by the update API, stored,
 * and never read by anything - `sharedPrompt`, `autonomousPrompt` and
 * `escalationGates` appeared NOWHERE in the codebase except the editable-field
 * allowlist that made them look supported.
 *
 * That is worse than an unused column. An integrator sets `escalationGates`,
 * receives a 200, and never learns the agent's escalation behaviour is
 * unchanged. The API's silence reads as agreement.
 *
 * This test does not assert a fixed list of "good" fields - the model will grow
 * and that is fine. It asserts the RULE: a field the update API accepts must be
 * read by something. Nothing may be settable and inert at the same time.
 */

const REPO = join(__dirname, "..", "..", "..", "..");
const ROUTE = join(__dirname, "..", "routes", "ai-agents.ts");

/** The fields the update endpoint will write. */
function editableFields(): string[] {
  const src = readFileSync(ROUTE, "utf-8");
  const start = src.indexOf("const AGENT_EDITABLE_FIELDS = [");
  const end = src.indexOf("] as const;", start);
  expect(start, "AGENT_EDITABLE_FIELDS not found - did the route change shape?").toBeGreaterThan(-1);
  return [...src.slice(start, end).matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

/**
 * Files referencing a field, excluding the places that merely DECLARE or
 * transport it: the CRUD route itself, the schema, tests, and the defaults
 * table. What is left is code that consults the value.
 */
function consumers(field: string, scope: "backend" | "all" = "all"): string[] {
  const dirs = scope === "backend" ? "services packages/shared/src" : "services packages/shared/src frontend/src";
  try {
    const out = execSync(
      `grep -rl --include=*.ts --include=*.tsx -E '\\b${field}\\b' ${dirs} 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf-8" },
    );
    return out.split("\n").filter(Boolean).filter((f) =>
      !f.includes("routes/ai-agents.ts") &&
      !f.includes("__tests__") &&
      !f.includes("ai-agent-defaults"),
    );
  } catch {
    return [];
  }
}

describe("every settable agent field is read by something", () => {
  const fields = editableFields();

  it("the allowlist parses", () => {
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain("systemPrompt");
  });

  it("does not accept a field that nothing anywhere consumes", () => {
    // Deliberately generous: ANY consumer counts, frontend included. The bar is
    // "something reads it", not "the prompt uses it" - a field that only drives
    // the builder UI is still doing a job, even if a smaller one.
    const inert = fields.filter((f) => consumers(f).length === 0);
    expect(
      inert,
      `these fields are accepted by PUT /api/ai-agents/:id and read by nothing. ` +
        `Either wire them up or drop them from AGENT_EDITABLE_FIELDS: ${inert.join(", ")}`,
    ).toEqual([]);
  });

  it("reports fields the UI can set but no backend code reads", () => {
    // A weaker smell than fully inert, and worth surfacing rather than failing
    // on: the merchant configures something in the agent editor, it saves, and
    // it changes nothing about how the agent behaves. `interactiveMessages` is
    // the current example - stored and rendered, never consulted at runtime.
    const uiOnly = fields.filter(
      (f) => consumers(f, "backend").length === 0 && consumers(f).length > 0,
    );
    if (uiOnly.length) {
      console.warn(
        `[agent-fields] settable and rendered, but no backend code reads them: ${uiOnly.join(", ")}. ` +
          `Each is a control the merchant can change that does nothing.`,
      );
    }
    // Ratchet at today's count. Lower it by wiring one up or removing it.
    expect(uiOnly.length).toBeLessThanOrEqual(1);
  });

  it("no longer accepts the three that were settable and inert", () => {
    // Named individually so a regression says WHICH one came back.
    for (const f of ["sharedPrompt", "autonomousPrompt", "escalationGates"]) {
      expect(fields, `${f} was settable and read by nothing`).not.toContain(f);
    }
  });

  it("still accepts the fields that genuinely drive behaviour", () => {
    // The counterweight: this test must not be satisfiable by deleting the
    // allowlist. These are verified consumers - the prompt builder reads
    // behavioralAnchors, the bot loop reads both autonomy caps.
    for (const f of ["systemPrompt", "behavioralAnchors", "maxAutonomousMessages",
                     "maxAutonomousMinutes", "escalationMessage", "customGuardrails"]) {
      expect(fields, `${f} drives behaviour and must stay editable`).toContain(f);
    }
  });

  it("never accepts a server-owned or tenancy field", () => {
    // The reason the allowlist exists at all: a rest-spread of req.body would
    // let a client move an agent between tenants.
    for (const f of ["tenantId", "id", "createdAt", "updatedAt", "readinessReport"]) {
      expect(fields, `${f} must never be client-settable`).not.toContain(f);
    }
  });
});
