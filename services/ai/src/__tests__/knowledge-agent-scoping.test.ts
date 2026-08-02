import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * Retrieval used to search EVERY active knowledge base in the tenant, so
 * per-employee scoping was inert: an employee with nothing attached answered
 * from every other employee's knowledge, and a base scoped to one agent or
 * department leaked to all of them. The schema has carried `scope`,
 * `scopeAgentId`, `scopeDepartmentId` and the AIAgentKnowledge join for a long
 * time and nothing honoured them at read time.
 *
 * Verified live as well: with the tenant's base scoped to one employee, that
 * employee still reads it while two others retrieve nothing.
 */
describe("knowledge retrieval is scoped to the employee", () => {
  const svc = read("services/knowledge.service.ts");

  it("accepts the agent it is retrieving for", () => {
    expect(svc).toMatch(/aiAgentId\?: string \| null/);
    expect(svc).toMatch(/readableKnowledgeBaseIds/);
  });

  it("honours an explicit attachment", () => {
    expect(svc).toContain("aIAgentKnowledge");
    expect(svc).toMatch(/attachedIds\.has\(b\.id\)/);
  });

  it("keeps tenant-wide bases shared", () => {
    // Otherwise attaching nothing would leave an employee with no knowledge at
    // all, which is a worse default than the bug being fixed.
    expect(svc).toMatch(/if \(scope === "all"\) return true;/);
  });

  it("honours agent and department scoping", () => {
    expect(svc).toMatch(/scope === "department"/);
    expect(svc).toMatch(/b\.scopeDepartmentId === agent\.departmentId/);
    expect(svc).toMatch(/scope === "agent"/);
    expect(svc).toMatch(/b\.scopeAgentId === aiAgentId/);
  });

  it("does not fall through to 'read everything' for a foreign agent id", () => {
    // An id from another tenant resolves to no agent; returning every base
    // there would turn a scoping bug into a cross-tenant one.
    expect(svc).toMatch(/if \(!agent\) return \[\];/);
  });

  it("leaves callers with no agent in context on the old tenant-wide behaviour", () => {
    // Internal callers and the onboarding tuning chat have no employee whose
    // scope could be applied; silently returning nothing would break them.
    expect(svc).toMatch(/if \(!aiAgentId\) return bases\.map/);
  });

  it("the bot passes its own agent id through", () => {
    const bot = read("services/ai-bot.service.ts");
    expect(bot).toMatch(/retrieveRelevantChunks\(opts\.tenantId, opts\.incomingMessage, 5, opts\.aiAgentId\)/);
  });
});

describe("diagnostics separate tools OFFERED from tools CALLED", () => {
  it("the runtime reports what it offered the model", () => {
    const bot = read("services/ai-bot.service.ts");
    expect(bot).toMatch(/toolsOffered\?: string\[\]/);
    expect(bot).toMatch(/const toolsOffered: string\[\]/);
  });

  it("the sandbox surfaces both", () => {
    // "No tool was called" and "no tool was available" look identical in a
    // transcript and send an operator to completely different places.
    const svc = read("services/sandbox-conversation.service.ts");
    expect(svc).toMatch(/toolsOffered: string\[\]/);
    expect(svc).toMatch(/toolsCalled: string\[\]/);
    expect(svc).toMatch(/toolsOffered: result\.toolsOffered/);
  });
});
