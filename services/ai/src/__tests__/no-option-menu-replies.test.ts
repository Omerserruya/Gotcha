import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripOptionMenu } from "../services/employee-tuning.service";

// __dirname, not import.meta: this service compiles as CommonJS, and
// import.meta is a tsc error under that module setting even though vitest
// happens to accept it.
const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * The reported symptom was an onboarding chat that answered with three
 * suggested replies instead of just replying. The cause was in the prompt, not
 * the UI: it asked the model to "propose 2-4 concrete SUCCESS CRITERIA". These
 * tests pin both the prompt fix and the runtime backstop.
 */
describe("onboarding chat: one natural answer, never a menu", () => {
  const tuning = read("services/employee-tuning.service.ts");

  it("no longer asks the model for multiple options", () => {
    expect(tuning).not.toMatch(/propose 2-4/i);
    expect(tuning).not.toMatch(/2-4 concrete/i);
  });

  it("explicitly forbids offering a menu of replies", () => {
    expect(tuning).toMatch(/NEVER offer the owner a menu/i);
    expect(tuning).toMatch(/Give ONE natural answer/i);
  });

  it("gives the onboarding chat real knowledge access", () => {
    // Without retrieval it could only answer from a one-line summary, which is
    // what "it doesn't understand my business" meant.
    expect(tuning).toContain("retrieveRelevantChunks");
    expect(tuning).toContain("buildKnowledgeContext");
  });
});

describe("stripOptionMenu - runtime backstop", () => {
  it("collapses an English option menu to the first real answer", () => {
    const out = stripOptionMenu(
      "Here are a few ways I could respond:\n1. Offer a refund straight away\n2. Ask for the order number\n3. Escalate to a human",
    );
    expect(out).toBe("Offer a refund straight away");
    expect(out).not.toMatch(/Here are/i);
  });

  it("handles bullets and the Hebrew form", () => {
    expect(stripOptionMenu("I could:\n- Check the order\n- Ask for details")).toBe("Check the order");
    expect(stripOptionMenu("הנה כמה אפשרויות:\n1. לבדוק את ההזמנה\n2. לשאול פרטים")).toBe("לבדוק את ההזמנה");
  });

  it("leaves an ordinary reply completely alone", () => {
    for (const ok of [
      "Sure, I can help with that. What's your order number?",
      "בטח, אני יכול לעזור. מה מספר ההזמנה?",
      // Mentions options but is not a menu.
      "We have a few options on the shelf, which size did you want?",
      "I'll check that for you now.",
    ]) {
      expect(stripOptionMenu(ok)).toBe(ok);
    }
  });

  it("does not fire on a genuine list the owner asked for", () => {
    // No option-menu preamble, so the list is content, not alternatives.
    const list = "Your top sellers are:\n1. Aeron chair\n2. Standing desk";
    expect(stripOptionMenu(list)).toBe(list);
  });

  it("is safe on empty and malformed input", () => {
    expect(stripOptionMenu("")).toBe("");
    expect(stripOptionMenu("Here are options:")).toBe("Here are options:");
  });
});

describe("test chat runs the production employee, not a lookalike", () => {
  it("the divergent sandbox implementation is gone", () => {
    let exists = true;
    try { read("services/agent-sandbox-chat.service.ts"); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("the route calls the sandbox conversation runner", () => {
    const route = read("routes/ai-agents.ts");
    expect(route).toContain("runSandboxTurn");
    expect(route).not.toContain("sandboxEmployeeChat");
  });

  it("the runner calls the same generator the incoming-worker calls", () => {
    const svc = read("services/sandbox-conversation.service.ts");
    expect(svc).toContain("generateAIBotReply");
    // Memory must come from a real conversation, not a client-sent transcript.
    expect(svc).toContain("ensureSandboxConversation");
  });

  it("the route no longer trusts a client-supplied transcript", () => {
    const route = read("routes/ai-agents.ts");
    expect(route).not.toMatch(/history\s*=\s*\[\]/);
  });

  it("sandbox conversations are marked so they stay out of real metrics", () => {
    const svc = read("services/sandbox-conversation.service.ts");
    expect(svc).toContain('handledBy: "sandbox"');
    expect(svc).toContain("sandbox:");
  });
});
