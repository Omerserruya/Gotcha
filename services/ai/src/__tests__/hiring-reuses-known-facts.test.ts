import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * The hiring conversation must not ask the owner for something they already
 * gave us. It already refused to re-ask what the company does; the gap was that
 * it reasoned about what the employee "will need to know" from a one-line
 * summary, so its plan was guesswork - it could promise to answer from a help
 * centre that does not exist, or ask for a returns policy already on file.
 */
describe("hiring flow reuses what we already know", () => {
  const builder = read("services/agent-builder.service.ts");

  it("still refuses to re-ask what the company does", () => {
    expect(builder).toMatch(/The company is ALREADY KNOWN - do NOT ask about it/);
    expect(builder).toMatch(/Do NOT ask what the company does/);
  });

  it("presents a seeded draft instead of re-interviewing", () => {
    expect(builder).toMatch(/present, don't re-interview/i);
    expect(builder).toMatch(/Do NOT re-ask for the goal, role, or name/);
  });

  it("keeps the interview short and one question at a time", () => {
    expect(builder).toMatch(/ONE focused, human question at a time/);
    expect(builder).toMatch(/4-6 questions, not 15/);
  });

  it("reads the tenant's REAL knowledge titles into the snapshot", () => {
    expect(builder).toContain("knowledgeTopics");
    expect(builder).toContain("prisma.knowledgeDocument");
    // Titles only - this feeds a prompt, it must not haul in document bodies.
    expect(builder).toMatch(/select: \{ title: true \}/);
    // Bounded, so a large knowledge base cannot blow up the prompt.
    expect(builder).toMatch(/take: 40/);
    expect(builder).toMatch(/slice\(0, 20\)/);
  });

  it("only ingests documents that are actually retrievable", () => {
    // A pending or errored document cannot be answered from, so promising it
    // would be another false success.
    expect(builder).toMatch(/status: "ready"/);
  });

  it("forbids asking for knowledge the business already provided", () => {
    expect(builder).toMatch(/NEVER ask the owner to provide something on this list/);
  });

  it("is honest when the business has written nothing down", () => {
    expect(builder).toMatch(/Nothing has been written down for this business yet/);
    expect(builder).toMatch(/no knowledge to answer from/);
  });

  it("still keeps knowledge and tool SELECTION out of the chat", () => {
    // Those are picked as cards in a dedicated admin step; collecting them over
    // chat is what made the old flow feel like a configuration form.
    expect(builder).toMatch(/Do NOT ask about, list, or attach knowledge bases or tools over chat/);
  });
});

describe("draft readiness gates activation on real gaps", () => {
  const builder = read("services/agent-builder.service.ts");
  it("reports what is missing rather than a bare boolean", () => {
    expect(builder).toMatch(/export function draftReadiness/);
    expect(builder).toMatch(/missing: string\[\]/);
  });
});
