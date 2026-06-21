import { describe, it, expect } from "vitest";
import {
  computeProspectState,
  renderProspectState,
} from "../services/prospect-state";
import {
  selectActiveObjective,
  renderObjectiveLedger,
  isPassiveCloser,
  customerIsClosing,
  buildCloserCorrective,
  OBJECTIVE_CHAINS,
} from "../services/objectives";
import { buildAgentPrompt, type AgentRecord } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

describe("Prospect State", () => {
  it("absence of a CRM record → NEW_PROSPECT", () => {
    expect(computeProspectState({ hasLead: false, hasContact: false })).toBe("NEW_PROSPECT");
  });
  it("derives KNOWN_CONTACT / OPEN_OPPORTUNITY / CUSTOMER by precedence", () => {
    expect(computeProspectState({ hasLead: true, hasContact: true })).toBe("KNOWN_CONTACT");
    expect(computeProspectState({ hasLead: false, hasContact: true, hasOpportunity: true })).toBe("OPEN_OPPORTUNITY");
    expect(computeProspectState({ hasLead: true, hasContact: true, isCustomer: true })).toBe("CUSTOMER");
  });
  it("renders NEW_PROSPECT=true explicitly", () => {
    const block = renderProspectState("NEW_PROSPECT");
    expect(block).toContain("# Prospect State");
    expect(block).toContain("NEW_PROSPECT=true");
    expect(block.toLowerCase()).toContain("lead generation");
  });
  it("renders NEW_PROSPECT=false for a known contact", () => {
    expect(renderProspectState("KNOWN_CONTACT")).toContain("NEW_PROSPECT=false");
  });
});

describe("Objective selection by prospect state", () => {
  it("SALES + NEW_PROSPECT (no facts) → GENERATE_LEAD as active", () => {
    const s = selectActiveObjective("sales", "NEW_PROSPECT", "");
    expect(s?.objective.id).toBe("GENERATE_LEAD");
    expect(s?.stepIndex).toBe(0);
    expect(s?.missingRequired).toContain("contact_name");
    expect(s?.missingRequired).toContain("contact_method");
  });

  it("SALES + KNOWN_CONTACT → skips GENERATE_LEAD, active is QUALIFY_LEAD", () => {
    const s = selectActiveObjective("sales", "KNOWN_CONTACT", "");
    expect(s?.objective.id).toBe("QUALIFY_LEAD");
    expect(s?.stepIndex).toBe(1);
  });

  it("advances along the chain as facts accumulate", () => {
    // need + authority + timeline known → QUALIFY_LEAD complete → BOOK_MEETING
    const facts = "need: faster replies. authority: owner. timeline: this quarter.";
    const s = selectActiveObjective("sales", "KNOWN_CONTACT", facts);
    expect(s?.objective.id).toBe("BOOK_MEETING");
  });

  it("SUPPORT chain is RESOLVE_ISSUE and does NOT hard-block closing", () => {
    const s = selectActiveObjective("customer_support", "NEW_PROSPECT", "");
    expect(s?.objective.id).toBe("RESOLVE_ISSUE");
    expect(s?.objective.blockPassiveClose).toBe(false);
  });

  it("every skill has a non-empty objective chain", () => {
    for (const chain of Object.values(OBJECTIVE_CHAINS)) {
      expect(chain.length).toBeGreaterThan(0);
    }
  });
});

describe("Objective Engine consumes live-conversation facts (regression fix)", () => {
  // The real WhatsApp regression: a NEW prospect who stated their business in
  // chat still read as business_type MISSING because the engine only saw
  // CRM/memory snapshots. Now the resolved-fact text includes session facts, so
  // a stated fact must satisfy the requirement immediately.
  it("business_type stated in the conversation flips it from MISSING → known", () => {
    const base = "- Name: Omer\n- email: omer@x.com";
    const stuck = selectActiveObjective("sales", "NEW_PROSPECT", base);
    expect(stuck?.objective.id).toBe("GENERATE_LEAD");
    expect(stuck?.missingRequired).toContain("business_type");

    // "industry: retail" matches business_type sourceHints → requirement met.
    const advanced = selectActiveObjective("sales", "NEW_PROSPECT", `${base}\n- industry: retail`);
    expect(advanced?.objective.id).not.toBe("GENERATE_LEAD");
  });

  it("explicit meeting request + captured identity PROMOTES BOOK_MEETING", () => {
    const facts = '- Name: Omer\n- Phone (WhatsApp): +972525401686\n- "can we meet Monday at 3?"';
    const s = selectActiveObjective("sales", "NEW_PROSPECT", facts);
    expect(s?.objective.id).toBe("BOOK_MEETING");
  });

  it("meeting request WITHOUT identity does NOT skip lead capture", () => {
    const s = selectActiveObjective("sales", "NEW_PROSPECT", '- "can we schedule a demo?"');
    expect(s?.objective.id).toBe("GENERATE_LEAD");
  });
});

describe("Objective Ledger render", () => {
  it("shows active objective, ✓/✗ required info, and the hard close-block", () => {
    const s = selectActiveObjective("sales", "NEW_PROSPECT", "");
    const md = renderObjectiveLedger(s, "")!;
    expect(md).toContain("# Objective Ledger (this turn)");
    expect(md).toContain("GENERATE_LEAD");
    expect(md).toContain("`contact_name`");
    expect(md).toContain("MISSING [required]");
    expect(md).toContain("⛔");
    expect(md).toContain("step 1/4");
  });
  it("when all objectives complete → may-close note, no ⛔", () => {
    const md = renderObjectiveLedger(null, "")!;
    expect(md.toLowerCase()).toContain("complete");
    expect(md).not.toContain("⛔");
  });
});

describe("Passive-closer gate detection", () => {
  it("flags the EXACT real-world regression closer", () => {
    const real = "אין בעיה! אם יש לך שאלות נוספות או נושאים אחרים שתרצה לדבר עליהם, אני כאן!";
    expect(isPassiveCloser(real)).toBe(true);
  });
  it("flags English availability closers", () => {
    expect(isPassiveCloser("Sure — anything else I can help with?")).toBe(true);
    expect(isPassiveCloser("Feel free to reach out anytime!")).toBe(true);
  });
  it("does NOT flag a forward-moving discovery reply", () => {
    expect(isPassiveCloser("בשמחה. לפני שאצלול, ספר לי קצת על העסק — איפה העומס הכי גדול היום?")).toBe(false);
  });
  it("'לא' / 'no' is not a customer farewell; 'ביי' is", () => {
    expect(customerIsClosing("לא")).toBe(false);
    expect(customerIsClosing("ביי תודה")).toBe(true);
    expect(customerIsClosing("no thanks")).toBe(true);
  });
  it("corrective names the objective and forbids passive opener/closer", () => {
    const s = selectActiveObjective("sales", "NEW_PROSPECT", "")!;
    const c = buildCloserCorrective(s);
    expect(c).toContain("GENERATE_LEAD");
    expect(c.toLowerCase()).toContain("not complete");
    expect(c.toLowerCase()).toContain("lead the conversation");
  });
});

describe("E2E — Objective Engine in the assembled prompt", () => {
  const agent: AgentRecord = {
    name: "Aria", role: "sales", persona: { brand_archetype: "sage" },
    conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null,
  };
  function prompt(crm?: any) {
    const behaviorState = computeBehaviorState({
      mode: "agent",
      identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
      request: { lastMessage: "tell me about your AI employees", messageCount: 2, recentInboundTexts: ["tell me"] },
    });
    return buildAgentPrompt({
      behaviorState, agent,
      context: { customerBlock: "## Customer\n- Name: Omer\n- Channel: whatsapp", locale: "en" },
      knowledge: {}, toolFunctionNames: ["integration_create_lead"], crm,
    } as any);
  }

  it("a NEW prospect (no CRM flags) renders Prospect State + GENERATE_LEAD objective", () => {
    const p = prompt(undefined);
    expect(p).toContain("# Prospect State (this turn)");
    expect(p).toContain("NEW_PROSPECT=true");
    expect(p).toContain("# Objective Ledger (this turn)");
    expect(p).toContain("GENERATE_LEAD");
    expect(p).toContain("`contact_name`");
    expect(p).toContain("⛔");
  });

  it("a known customer renders CUSTOMER state and skips lead generation as the ACTIVE objective", () => {
    const p = prompt({ hasLead: true, hasContact: true, isCustomer: true });
    expect(p).toContain("NEW_PROSPECT=false");
    expect(p).toContain("CUSTOMER");
    // GENERATE_LEAD may still appear in the chain line, but must NOT be active.
    expect(p).toContain("Active objective: **QUALIFY_LEAD**");
    expect(p).not.toContain("Active objective: **GENERATE_LEAD**");
  });
});
