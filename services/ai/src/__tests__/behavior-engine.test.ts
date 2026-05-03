import { describe, it, expect } from "vitest";
import { computeBehaviorState, shouldRetrieveKB } from "../services/behavior-engine.service";

const baseIdentity = {
  unknown: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 } as const,
  newLead: { hasContact: true, contactLifecycle: "lead" as const, priorConversationCount: 0 },
  returning: { hasContact: true, contactLifecycle: "lead" as const, priorConversationCount: 2 },
  customer: { hasContact: true, contactLifecycle: "customer" as const, priorConversationCount: 5 },
};

describe("BehaviorEngine — user_type resolution", () => {
  it("emits unknown when no contact exists", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.unknown,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.userType).toBe("unknown");
  });

  it("emits new_lead for a lead with no prior conversations", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.userType).toBe("new_lead");
  });

  it("emits returning for a lead with prior conversations", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.returning,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.userType).toBe("returning");
  });

  it("emits customer when lifecycle=customer", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.userType).toBe("customer");
  });
});

describe("BehaviorEngine — conversation_stage", () => {
  it("messageCount<=1 → initial", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i'd like info", messageCount: 1 },
    });
    expect(s.conversationStage).toBe("initial");
  });

  it("support marker → support stage", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "my login is broken, i can't get in", messageCount: 4 },
    });
    expect(s.conversationStage).toBe("support");
  });

  it("objection marker → objection stage", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i don't think this is for us, too expensive", messageCount: 4 },
    });
    expect(s.conversationStage).toBe("objection");
  });

  it("decision marker → decision stage", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "ok let's book a call", messageCount: 5 },
    });
    expect(s.conversationStage).toBe("decision");
  });
});

describe("BehaviorEngine — strategy decision matrix", () => {
  it("agent + new_lead + initial → QUALIFY", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi there", messageCount: 1 },
    });
    expect(s.strategy).toBe("QUALIFY");
  });

  it("agent + new_lead + exploration + informational → GUIDE", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "how does it work?", messageCount: 4 },
    });
    expect(s.conversationStage).toBe("exploration");
    expect(s.intent).toBe("informational");
    expect(s.strategy).toBe("GUIDE");
  });

  it("price/cost question on a lead → flips to CONVERT (buying signal)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "כמה עולה השירות?", messageCount: 6 },
    });
    expect(s.intent).toBe("transactional");
    expect(s.strategy).toBe("CONVERT");
  });

  it("english pricing question on a lead → CONVERT", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price for the team plan?", messageCount: 5 },
    });
    expect(s.intent).toBe("transactional");
    expect(s.strategy).toBe("CONVERT");
  });

  it("demo request → CONVERT", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "can i see a demo?", messageCount: 3 },
    });
    expect(s.strategy).toBe("CONVERT");
  });

  it("agent + decision stage → CONVERT", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "let's book it", messageCount: 6 },
    });
    expect(s.strategy).toBe("CONVERT");
  });

  it("agent + objection on a lead → CONVERT (with soft tone)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i'm not sure, it seems too expensive", messageCount: 5 },
    });
    expect(s.conversationStage).toBe("objection");
    expect(s.strategy).toBe("CONVERT");
    expect(s.toneIntensity).toBe("soft");
  });

  it("agent + customer + support intent → RESOLVE", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "my login is broken", messageCount: 4 },
    });
    expect(s.strategy).toBe("RESOLVE");
  });

  it("copilot mode → SUPPORT_AGENT regardless of axes", () => {
    const s = computeBehaviorState({
      mode: "copilot",
      identity: baseIdentity.customer,
      request: { lastMessage: "my login is broken urgently", messageCount: 9 },
    });
    expect(s.strategy).toBe("SUPPORT_AGENT");
    expect(s.autonomy).toBe("advisory");
  });

  it("generator mode → N/A", () => {
    const s = computeBehaviorState({
      mode: "generator",
      identity: baseIdentity.unknown,
      request: { lastMessage: "", messageCount: 0 },
    });
    expect(s.strategy).toBe("N/A");
    expect(s.autonomy).toBe("advisory");
  });

  it("hot engagement + transactional → CONVERT override", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.returning,
      // 6+ messages → hot engagement
      request: { lastMessage: "להזמין דמו", messageCount: 8 },
    });
    expect(s.engagementLevel).toBe("hot");
    expect(s.intent).toBe("transactional");
    expect(s.strategy).toBe("CONVERT");
  });
});

describe("BehaviorEngine — overrides", () => {
  it("urgency=high + support intent → RESOLVE override", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "URGENT: my account is broken right now", messageCount: 1 },
    });
    expect(s.urgency).toBe("high");
    expect(s.strategy).toBe("RESOLVE");
    expect(s.provenance.overrides.some((o) => o.includes("force RESOLVE"))).toBe(true);
  });

  it("escalation gate fired → force RESOLVE + escalate_now + advisory autonomy + decisionIntent=ESCALATE", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
      flags: { escalationGateFired: true },
    });
    expect(s.strategy).toBe("RESOLVE");
    expect(s.escalationPressure).toBe("escalate_now");
    expect(s.autonomy).toBe("advisory");
    expect(s.decisionIntent).toBe("ESCALATE");
    expect(s.requiredActions).toContain("escalate_to_human");
  });

  it("human handoff request → force RESOLVE + escalate_now + decisionIntent=ESCALATE", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "I want to speak to a human agent", messageCount: 3 },
      flags: { humanHandoffRequested: true },
    });
    expect(s.strategy).toBe("RESOLVE");
    expect(s.decisionIntent).toBe("ESCALATE");
  });
});

describe("BehaviorEngine — autonomy degradation", () => {
  it("agent + low confidence (intent=unclear) → gated", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "...", messageCount: 4 },
    });
    expect(s.confidence).toBe("low");
    expect(s.autonomy).toBe("gated");
  });

  it("agent + pending approvals → gated + decisionIntent=HOLD", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "yes that's fine", messageCount: 4 },
      flags: { pendingApprovalsCount: 1 },
    });
    expect(s.autonomy).toBe("gated");
    expect(s.decisionIntent).toBe("HOLD");
  });

  it("agent + clean state → full + PROGRESS", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "how does pricing work?", messageCount: 4 },
    });
    expect(s.autonomy).toBe("full");
    expect(s.decisionIntent).toBe("PROGRESS");
  });
});

describe("BehaviorEngine — outputContract derivation", () => {
  it("agent mode → REPLY", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.outputContract).toBe("REPLY");
  });

  it("copilot mode without preference → READY_MESSAGE", () => {
    const s = computeBehaviorState({
      mode: "copilot",
      identity: baseIdentity.customer,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.outputContract).toBe("READY_MESSAGE");
  });

  it("copilot mode with CHAT preference → CHAT", () => {
    const s = computeBehaviorState({
      mode: "copilot",
      identity: baseIdentity.customer,
      request: { lastMessage: "hi", messageCount: 1 },
      copilotPreferredMode: "CHAT",
    });
    expect(s.outputContract).toBe("CHAT");
  });

  it("copilot mode with CONTEXT_ONLY preference → CONTEXT_ONLY", () => {
    const s = computeBehaviorState({
      mode: "copilot",
      identity: baseIdentity.customer,
      request: { lastMessage: "hi", messageCount: 1 },
      copilotPreferredMode: "CONTEXT_ONLY",
    });
    expect(s.outputContract).toBe("CONTEXT_ONLY");
  });

  it("generator mode → STRUCTURED_CONFIG", () => {
    const s = computeBehaviorState({
      mode: "generator",
      identity: baseIdentity.unknown,
      request: { lastMessage: "", messageCount: 0 },
    });
    expect(s.outputContract).toBe("STRUCTURED_CONFIG");
  });
});

describe("BehaviorEngine — allowedActions derivation (BEL is the only filter)", () => {
  it("QUALIFY exposes ask_question + crm_read + identity_link, NOT create_lead", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.allowedActions).toContain("ask_question");
    expect(s.allowedActions).toContain("crm_read");
    expect(s.allowedActions).toContain("identity_link");
    expect(s.allowedActions).not.toContain("create_lead");
  });

  it("CONVERT exposes create_lead and schedule_booking", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price for the team plan?", messageCount: 5 },
    });
    expect(s.strategy).toBe("CONVERT");
    expect(s.allowedActions).toContain("create_lead");
    expect(s.allowedActions).toContain("schedule_booking");
  });

  it("CONVERT + existing CRM lead → drops create_lead from allowedActions", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: { ...baseIdentity.newLead, crmRecord: { hasLead: true, hasContact: false } },
      request: { lastMessage: "what's the price?", messageCount: 5 },
    });
    expect(s.strategy).toBe("CONVERT");
    expect(s.allowedActions).not.toContain("create_lead");
    expect(s.allowedActions).toContain("update_record");
  });

  it("CONVERT + existing CRM contact → drops create_contact", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: { ...baseIdentity.newLead, crmRecord: { hasLead: false, hasContact: true } },
      request: { lastMessage: "let's book it", messageCount: 5 },
    });
    expect(s.allowedActions).not.toContain("create_contact");
  });

  it("pendingApprovals → drops heavy writes from allowedActions", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "let's book it", messageCount: 5 },
      flags: { pendingApprovalsCount: 1 },
    });
    expect(s.allowedActions).not.toContain("create_lead");
    expect(s.allowedActions).not.toContain("update_record");
    expect(s.allowedActions).not.toContain("schedule_booking");
    expect(s.allowedActions).toContain("crm_read");
  });

  it("advisory autonomy strips all writes regardless of strategy", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "I want to speak to a human", messageCount: 3 },
      flags: { humanHandoffRequested: true },
    });
    expect(s.autonomy).toBe("advisory");
    expect(s.allowedActions).not.toContain("create_lead");
    expect(s.allowedActions).not.toContain("update_record");
    expect(s.allowedActions).toContain("escalate_to_human");
  });
});

describe("BehaviorEngine — requiredActions enforcement", () => {
  it("escalation gate → MUST escalate_to_human", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
      flags: { escalationGateFired: true },
    });
    expect(s.requiredActions).toContain("escalate_to_human");
  });

  it("CONVERT + transactional + no CRM record → MUST create_lead AND schedule_booking", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: { ...baseIdentity.newLead, crmRecord: { hasLead: false, hasContact: false } },
      request: { lastMessage: "what's the price?", messageCount: 5 },
    });
    expect(s.strategy).toBe("CONVERT");
    expect(s.requiredActions).toContain("create_lead");
    expect(s.requiredActions).toContain("schedule_booking");
  });

  it("CONVERT + transactional + existing CRM lead → MUST update_record (not create)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: { ...baseIdentity.newLead, crmRecord: { hasLead: true, hasContact: false } },
      request: { lastMessage: "what's the price?", messageCount: 5 },
    });
    expect(s.requiredActions).toContain("update_record");
    expect(s.requiredActions).not.toContain("create_lead");
  });

  it("RESOLVE → MUST crm_read first", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "my login is broken", messageCount: 4 },
    });
    expect(s.strategy).toBe("RESOLVE");
    expect(s.requiredActions).toContain("crm_read");
  });

  it("QUALIFY phase 2 (exploration) → MUST ask_question", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.unknown,
      // No SUPPORT/OBJECTION/DECISION/TRANSACTIONAL/INFORMATIONAL marker → intent=unclear → QUALIFY
      request: { lastMessage: "אני סתם מסתובב פה", messageCount: 3 },
    });
    expect(s.strategy).toBe("QUALIFY");
    expect(s.conversationStage).not.toBe("initial");
    expect(s.requiredActions).toContain("ask_question");
  });

  it("QUALIFY initial turn has no required action (greet phase)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "היי", messageCount: 1 },
    });
    expect(s.strategy).toBe("QUALIFY");
    expect(s.conversationStage).toBe("initial");
    expect(s.requiredActions).toEqual([]);
  });
});

describe("BehaviorEngine — playbook selection", () => {
  it("price-objection markers + objection stage → price_objection playbook", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      // "יקר מדי" is the exact OBJECTION marker substring.
      request: { lastMessage: "יקר מדי בשבילי", messageCount: 5 },
    });
    expect(s.conversationStage).toBe("objection");
    expect(s.playbookIds).toContain("price_objection");
  });

  it("demo request → demo_request playbook", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "can i see a demo of the system?", messageCount: 3 },
    });
    expect(s.playbookIds).toContain("demo_request");
  });

  it("QUALIFY exploration → lead_qualification playbook", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.unknown,
      // Plain message with no informational/transactional/support/objection/decision markers.
      request: { lastMessage: "אני סתם מסתובב פה", messageCount: 3 },
    });
    expect(s.strategy).toBe("QUALIFY");
    expect(s.conversationStage).toBe("exploration");
    expect(s.playbookIds).toContain("lead_qualification");
  });

  it("deferral marker → deferral_handling playbook", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "i'll think about it and get back to you", messageCount: 5 },
    });
    expect(s.playbookIds).toContain("deferral_handling");
  });

  it("trust marker → trust_concern playbook", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "are you legit? have you done this before?", messageCount: 4 },
    });
    expect(s.playbookIds).toContain("trust_concern");
  });

  it("first turn greeting → no playbooks selected", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "היי", messageCount: 1 },
    });
    expect(s.playbookIds).toEqual([]);
  });
});

describe("BehaviorEngine — KB gating (BEL-controlled)", () => {
  it("QUALIFY (knowledgeRetrieval=skip) → shouldRetrieveKB=false even on rich text", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "tell me about your features and integrations", messageCount: 1 },
    });
    expect(s.strategy).toBe("QUALIFY");
    expect(shouldRetrieveKB(s, "tell me about your features and integrations")).toBe(false);
  });

  it("RESOLVE (knowledgeRetrieval=always) → shouldRetrieveKB=true even on bare 'ok'", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "my login is broken", messageCount: 4 },
    });
    expect(s.strategy).toBe("RESOLVE");
    expect(shouldRetrieveKB(s, "ok")).toBe(true);
  });

  it("GUIDE (knowledgeRetrieval=always) → shouldRetrieveKB=true on a feature question", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "how does the routing work?", messageCount: 4 },
    });
    expect(s.strategy).toBe("GUIDE");
    expect(shouldRetrieveKB(s, "how does the routing work?")).toBe(true);
  });

  it("CONVERT (knowledgeRetrieval=when_relevant) — short greeting → false", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price?", messageCount: 5 },
    });
    expect(s.strategy).toBe("CONVERT");
    expect(shouldRetrieveKB(s, "hi")).toBe(false);
  });
});

describe("BehaviorEngine — provenance + determinism", () => {
  it("populates provenance for every axis", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price?", messageCount: 4 },
    });
    expect(s.provenance.userType).not.toBe("");
    expect(s.provenance.conversationStage).not.toBe("");
    expect(s.provenance.intent).not.toBe("");
    expect(s.provenance.urgency).not.toBe("");
    expect(s.provenance.strategy).not.toBe("");
    expect(s.provenance.outputContract).not.toBe("");
    expect(s.provenance.decisionIntent).not.toBe("");
    expect(s.provenance.allowedActions).not.toBe("");
    expect(s.provenance.requiredActions).not.toBe("");
    expect(s.provenance.playbookIds).not.toBe("");
  });

  it("is deterministic — same inputs produce same outputs", () => {
    const input = {
      mode: "agent" as const,
      identity: baseIdentity.newLead,
      request: { lastMessage: "i want to buy", messageCount: 3 },
    };
    const a = computeBehaviorState(input);
    const b = computeBehaviorState(input);
    expect(a).toEqual(b);
  });
});
