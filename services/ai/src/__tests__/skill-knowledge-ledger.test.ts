import { describe, it, expect } from "vitest";
import {
  selectSkill,
  roleToSkill,
  renderSkill,
  buildSkillBlock,
  requiredKnowledgeFor,
} from "../services/skills";
import {
  computeKnowledgeLedger,
  renderKnowledgeLedger,
} from "../services/knowledge-ledger";

describe("Skill model - structured operating systems", () => {
  it("maps roles to the right skill and falls back to GENERIC", () => {
    expect(roleToSkill("sales")).toBe("SALES");
    expect(roleToSkill("customer_success")).toBe("CUSTOMER_SUCCESS");
    expect(roleToSkill("BILLING")).toBe("SUPPORT");
    expect(roleToSkill("nonsense")).toBe("GENERIC");
    expect(roleToSkill(null)).toBe("GENERIC");
  });

  it("every skill defines the full professional template (§8) + objective + memory", () => {
    for (const role of ["sales", "support", "sdr", "customer_success", "receptionist", "custom"]) {
      const s = selectSkill(role);
      expect(s.mission.length).toBeGreaterThan(0);
      expect(s.conversationObjective.length).toBeGreaterThan(0);
      expect(s.methodologyDoc.length).toBeGreaterThan(0);
      expect(s.conversationFlow.length).toBeGreaterThan(0);
      expect(s.successCriteria.length).toBeGreaterThan(0);
      expect(s.failureCriteria.length).toBeGreaterThan(0);
      expect(s.requiredKnowledge.length).toBeGreaterThan(0);
      expect(s.discoveryStrategy.length).toBeGreaterThan(0);
      expect(s.memoryUsageStrategy.length).toBeGreaterThan(0);
      expect(s.escalationRules.length).toBeGreaterThan(0);
      expect(s.closingRules.length).toBeGreaterThan(0);
    }
  });

  it("every required-knowledge field carries a distinct priority (ordering is well-defined)", () => {
    for (const role of ["sales", "support", "sdr", "customer_success", "receptionist", "custom"]) {
      const ks = selectSkill(role).requiredKnowledge;
      for (const k of ks) expect(typeof k.priority).toBe("number");
      const priorities = ks.map((k) => k.priority);
      expect(new Set(priorities).size).toBe(priorities.length); // no duplicates
    }
  });

  it("conversationObjective encodes the role's true end-goal", () => {
    expect(selectSkill("sales").conversationObjective.toLowerCase()).toMatch(/demo|meeting|trial|quote/);
    expect(selectSkill("support").conversationObjective.toLowerCase()).toMatch(/resol|escalat/);
    expect(selectSkill("sdr").conversationObjective.toLowerCase()).toMatch(/book/);
    expect(selectSkill("receptionist").conversationObjective.toLowerCase()).toMatch(/rout/);
  });

  it("SALES has anti-give-up recovery + strengthened failure criteria", () => {
    const sales = selectSkill("sales");
    expect(sales.recoveryStrategy && sales.recoveryStrategy.length).toBeTruthy();
    const fail = sales.failureCriteria.join(" ").toLowerCase();
    expect(fail).toContain("short"); // short reply ≠ end
    expect(fail).toContain("gave up");
    const block = buildSkillBlock("sales");
    expect(block).toContain("Recovery / never give up");
    expect(block).toContain("Using memory");
    expect(block).toContain("Conversation objective");
  });

  it("renderSkill lists required knowledge in priority order", () => {
    const block = buildSkillBlock("sales");
    // business_type (priority 1) must appear before company_size (priority 5)
    expect(block.indexOf("business_type")).toBeLessThan(block.indexOf("company_size"));
  });

  it("SALES failure criteria encode the FAQ-bot anti-pattern", () => {
    const sales = selectSkill("sales");
    const joined = sales.failureCriteria.join(" ").toLowerCase();
    expect(joined).toContain("faq");
    expect(joined).toContain("discovery");
  });

  it("renderSkill is deterministic (cache-stable)", () => {
    expect(buildSkillBlock("sales")).toEqual(buildSkillBlock("sales"));
    expect(renderSkill(selectSkill("sdr"))).toEqual(renderSkill(selectSkill("sdr")));
  });

  it("renderSkill surfaces mission, success, failure and required knowledge", () => {
    const block = buildSkillBlock("sales");
    expect(block).toContain("Mission:");
    expect(block).toContain("You succeed when:");
    expect(block).toContain("You FAIL if you:");
    expect(block).toContain("Required knowledge");
    expect(block).toContain("business_type");
  });
});

describe("Knowledge ledger - deterministic gap detection", () => {
  const sdrKnowledge = requiredKnowledgeFor("sdr"); // need, authority, budget, timeline

  it("marks everything missing on an empty context (drives discovery)", () => {
    const ledger = computeKnowledgeLedger(sdrKnowledge, "");
    expect(ledger.entries.every((e) => !e.known)).toBe(true);
    expect(ledger.hasMissingRequired).toBe(true);
    expect(ledger.nextTarget?.key).toBe("need"); // first required missing
  });

  it("flips a field to known when its value/hint appears in fact text", () => {
    const factText = "CRM: timeline = next quarter. Authority: VP of Ops.";
    const ledger = computeKnowledgeLedger(sdrKnowledge, factText);
    const byKey = Object.fromEntries(ledger.entries.map((e) => [e.key, e.known]));
    expect(byKey.timeline).toBe(true);
    expect(byKey.authority).toBe(true);
    expect(byKey.need).toBe(false);
  });

  it("picks the first still-missing REQUIRED field as next target", () => {
    // need satisfied; authority (required) still missing → next target.
    const ledger = computeKnowledgeLedger(sdrKnowledge, "they need to reduce response time");
    expect(ledger.nextTarget?.key).toBe("authority");
  });

  it("reports no missing-required once all required fields are present", () => {
    const factText = "need: faster replies. authority: owner. budget: yes. timeline: now.";
    const ledger = computeKnowledgeLedger(sdrKnowledge, factText);
    expect(ledger.hasMissingRequired).toBe(false);
  });

  it("renders a ✓/✗ ledger with a next-target nudge", () => {
    const ledger = computeKnowledgeLedger(sdrKnowledge, "");
    const md = renderKnowledgeLedger(ledger);
    expect(md).toContain("# Knowledge Ledger");
    expect(md).toContain("✗");
    expect(md).toContain("Most natural next thing to learn");
  });

  it("returns null when the skill has no required knowledge", () => {
    expect(renderKnowledgeLedger(computeKnowledgeLedger([], "anything"))).toBeNull();
  });
});
