import { describe, it, expect } from "vitest";
import { computeBehaviorState, shouldRetrieveKB } from "../services/behavior-engine.service";
import { SAAS_DEFAULT_FUNNEL } from "../services/funnel-config.service";

const baseIdentity = {
  unknown: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 } as const,
  newLead: { hasContact: true, contactLifecycle: "lead" as const, priorConversationCount: 0 },
  returning: { hasContact: true, contactLifecycle: "lead" as const, priorConversationCount: 2 },
  customer: { hasContact: true, contactLifecycle: "customer" as const, priorConversationCount: 5 },
};

describe("BehaviorEngine - user_type resolution", () => {
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

describe("BehaviorEngine - conversation_stage", () => {
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

describe("BehaviorEngine - strategy decision matrix", () => {
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

describe("BehaviorEngine - overrides", () => {
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

describe("BehaviorEngine - autonomy degradation", () => {
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

describe("BehaviorEngine - outputContract derivation", () => {
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

describe("BehaviorEngine - allowedActions derivation (BEL is the only filter)", () => {
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

describe("BehaviorEngine - requiredActions enforcement", () => {
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

describe("BehaviorEngine - playbook selection", () => {
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

describe("BehaviorEngine - KB gating (BEL-controlled)", () => {
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

  it("CONVERT (knowledgeRetrieval=when_relevant) - short greeting → false", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price?", messageCount: 5 },
    });
    expect(s.strategy).toBe("CONVERT");
    expect(shouldRetrieveKB(s, "hi")).toBe(false);
  });
});

describe("BehaviorEngine - ownership signal (Task 1)", () => {
  it("no identifier in message → ownership none, confidence 0", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hello there", messageCount: 1 },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(false);
    expect(s.ownershipSignal.evidence).toBe("none");
    expect(s.requiredActions).not.toContain("identity_link");
  });

  it("direct response to assistant question → confidence 0.9 + identity_link required", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "omerts58@gmail.com",
        messageCount: 3,
        identifierMessage: { kind: "email", value: "omerts58@gmail.com" },
        assistantPreviouslyAskedFor: "email",
      },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(true);
    expect(s.ownershipSignal.evidence).toBe("direct_response_to_assistant_question");
    expect(s.ownershipSignal.confidence).toBe(0.9);
    expect(s.requiredActions).toContain("identity_link");
  });

  it("self-referential phrase → confidence 0.85 + identity_link required", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "האימייל שלי omerts58@gmail.com",
        messageCount: 3,
        identifierMessage: { kind: "email", value: "omerts58@gmail.com" },
      },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(true);
    expect(s.ownershipSignal.evidence).toBe("self_referential_phrase");
    expect(s.requiredActions).toContain("identity_link");
  });

  it("third-party marker → ownership false, identity_link NOT required", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "תשלחו ל support@company.com",
        messageCount: 3,
        identifierMessage: { kind: "email", value: "support@company.com" },
      },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(false);
    expect(s.ownershipSignal.evidence).toBe("third_party");
    expect(s.requiredActions).not.toContain("identity_link");
  });

  it("bare identifier without question → implicit context, confidence 0.7", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "omerts58@gmail.com",
        messageCount: 3,
        identifierMessage: { kind: "email", value: "omerts58@gmail.com" },
      },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(true);
    expect(s.ownershipSignal.evidence).toBe("implicit_context");
    expect(s.ownershipSignal.confidence).toBe(0.7);
    expect(s.requiredActions).toContain("identity_link");
  });

  it("ambiguous mid-sentence identifier → confidence 0.3, no identity_link", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "i was talking to john@friend.com last week",
        messageCount: 5,
        identifierMessage: { kind: "email", value: "john@friend.com" },
      },
    });
    expect(s.ownershipSignal.ownerIsCustomer).toBe(false);
    expect(s.ownershipSignal.evidence).toBe("ambiguous");
    expect(s.requiredActions).not.toContain("identity_link");
  });
});

describe("BehaviorEngine - funnel integration (Task 2)", () => {
  it("funnel-less call leaves strategy + playbooks alone", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "tell me about pricing", messageCount: 3 },
    });
    expect(s.provenance.strategy).not.toContain("funnel-overridden");
    expect(s.provenance.playbookIds).not.toContain("funnel-overridden");
  });

  it("SaaS funnel demo+informational → strategy override CONVERT applied via BEL", () => {
    // 'tell me' = informational marker; 'demo' = funnel stage marker.
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "tell me about your demo", messageCount: 3 },
      funnel: SAAS_DEFAULT_FUNNEL,
    });
    expect(s.strategy).toBe("CONVERT");
    expect(s.provenance.strategy).toContain("funnel-overridden");
    expect(s.provenance.overrides.some((o) => o.includes("funnel.strategy_override"))).toBe(true);
  });

  it("SaaS funnel qualified stage → playbook override fires", () => {
    // Informational message without 'demo' marker → demo stage skipped,
    // qualified stage entered.
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what features do you offer", messageCount: 3 },
      funnel: SAAS_DEFAULT_FUNNEL,
    });
    expect(s.provenance.overrides.some((o) => o.includes("funnel.stage=qualified"))).toBe(true);
  });
});

describe("BehaviorEngine - closure posture (Task 4)", () => {
  it("default mid-flight → posture=open, no closure required", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "tell me more about pricing", messageCount: 3 },
    });
    expect(s.closurePosture).toBe("open");
    expect(s.requiredActions).not.toContain("close_conversation");
    expect(s.requiredActions).not.toContain("schedule_followup");
  });

  it("customer defers ('let me think') → posture=needs_followup + schedule_followup", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "let me think about it and i'll get back to you", messageCount: 5 },
    });
    expect(s.closurePosture).toBe("needs_followup");
    expect(s.requiredActions).toContain("schedule_followup");
    expect(s.requiredActions).not.toContain("close_conversation");
  });

  it("Hebrew defer ('אחזור אליך') → needs_followup", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "אחשוב על זה ואחזור אליך", messageCount: 5 },
    });
    expect(s.closurePosture).toBe("needs_followup");
    expect(s.requiredActions).toContain("schedule_followup");
  });

  it("customer thanks after closing assistant move → ready_to_close + close_conversation", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "perfect, thanks!",
        messageCount: 7,
        lastAssistantMove: "close",
      },
    });
    expect(s.closurePosture).toBe("ready_to_close");
    expect(s.requiredActions).toContain("close_conversation");
  });

  it("hard decline ('not interested') → ready_to_close (no follow-up)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "not interested, thanks", messageCount: 4 },
    });
    expect(s.closurePosture).toBe("ready_to_close");
    expect(s.requiredActions).toContain("close_conversation");
    expect(s.requiredActions).not.toContain("schedule_followup");
  });

  it("pending approvals block closure (HOLD overrides)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "perfect, thanks!", messageCount: 7, lastAssistantMove: "close" },
      flags: { pendingApprovalsCount: 1 },
    });
    expect(s.closurePosture).toBe("open");
    expect(s.requiredActions).not.toContain("close_conversation");
  });

  it("escalate_now beats closure - escalate_to_human wins", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "thanks but I want a human, this is urgent", messageCount: 4, lastAssistantMove: "close" },
      flags: { humanHandoffRequested: true },
    });
    expect(s.requiredActions).toContain("escalate_to_human");
    expect(s.requiredActions).not.toContain("close_conversation");
  });

  it("provenance includes closure-posture rule when fired", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "let me think about it", messageCount: 5 },
    });
    expect(s.provenance.requiredActions).toContain("needs_followup");
  });
});

describe("BehaviorEngine - provenance + determinism", () => {
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

  it("is deterministic - same inputs produce same outputs", () => {
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

// ─── Behavioral signals (PHASE 1 - observe-only) ─────────────

describe("BehaviorEngine - relationshipStrength", () => {
  it("first-time customer (no contact) → low", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.unknown,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.relationshipStrength.level).toBe("low");
    expect(s.relationshipStrength.confidence).toBe("high");
    expect(s.relationshipStrength.reason).toMatch(/first-time/i);
    expect(s.relationshipStrength.evidence.length).toBeGreaterThan(0);
  });

  it("new lead (lead, 0 prior) → low", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.relationshipStrength.level).toBe("low");
    expect(s.relationshipStrength.reason).toMatch(/new lead/i);
  });

  it("returning lead (lead, >=1 prior) → medium", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.returning,
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.relationshipStrength.level).toBe("medium");
    expect(s.relationshipStrength.reason).toMatch(/returning lead/i);
  });

  it("existing customer (customer, <3 prior) → medium", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: { hasContact: true, contactLifecycle: "customer", priorConversationCount: 2 },
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.relationshipStrength.level).toBe("medium");
    expect(s.relationshipStrength.reason).toMatch(/existing customer/i);
  });

  it("long-term customer (customer, >=3 prior) → high", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer, // priorConversationCount: 5
      request: { lastMessage: "hi", messageCount: 1 },
    });
    expect(s.relationshipStrength.level).toBe("high");
    expect(s.relationshipStrength.confidence).toBe("high");
    expect(s.relationshipStrength.reason).toMatch(/long-term/i);
  });
});

describe("BehaviorEngine - customerTrust", () => {
  it("skeptical language → low", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "sounds too good to be true, are you a bot?", messageCount: 2 },
    });
    expect(s.customerTrust.level).toBe("low");
    expect(s.customerTrust.reason).toMatch(/skeptical/i);
    expect(s.customerTrust.evidence.length).toBeGreaterThan(0);
  });

  it("repeated verification requests across messages → low", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "how do i know this is official?",
        messageCount: 4,
        recentInboundTexts: [
          "can you confirm this is real?",
          "ok but how do i know this is official?",
        ],
      },
    });
    expect(s.customerTrust.level).toBe("low");
    expect(s.customerTrust.reason).toMatch(/repeated verification/i);
  });

  it("positive engagement → high", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "מעולה, תודה רבה!", messageCount: 3 },
    });
    expect(s.customerTrust.level).toBe("high");
    expect(s.customerTrust.reason).toMatch(/positive engagement/i);
  });

  it("long-term relationship with neutral message → high baseline", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: { lastMessage: "can we adjust the delivery window", messageCount: 2 },
    });
    expect(s.customerTrust.level).toBe("high");
    expect(s.customerTrust.reason).toMatch(/long-term relationship/i);
  });

  it("neutral new lead → medium", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what integrations do you support", messageCount: 2 },
    });
    expect(s.customerTrust.level).toBe("medium");
  });
});

describe("BehaviorEngine - customerFriction", () => {
  it("escalation/handoff flag → high (deterministic)", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "I need help", messageCount: 3 },
      flags: { humanHandoffRequested: true },
    });
    expect(s.customerFriction.level).toBe("high");
    expect(s.customerFriction.confidence).toBe("high");
    expect(s.customerFriction.reason).toMatch(/escalation\/handoff/i);
  });

  it("repeated complaints across messages → high", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.customer,
      request: {
        lastMessage: "this is the third time it's still not working",
        messageCount: 6,
        recentInboundTexts: [
          "the export still doesn't work",
          "this is the third time it's still not working",
        ],
      },
    });
    expect(s.customerFriction.level).toBe("high");
    expect(s.customerFriction.reason).toMatch(/repeated complaints/i);
  });

  it("customer repeating themselves → high", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: {
        lastMessage: "where is my order??",
        messageCount: 5,
        recentInboundTexts: ["where is my order", "where is my order??"],
      },
    });
    expect(s.customerFriction.level).toBe("high");
    expect(s.customerFriction.reason).toMatch(/repeating themselves/i);
  });

  it("single negative-sentiment message → medium", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "the dashboard doesn't work", messageCount: 2 },
    });
    expect(s.customerFriction.level).toBe("medium");
    expect(s.customerFriction.reason).toMatch(/negative sentiment/i);
  });

  it("calm conversation → low", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price?", messageCount: 2 },
    });
    expect(s.customerFriction.level).toBe("low");
  });
});

describe("BehaviorEngine - signals: provenance, determinism, degradation", () => {
  it("every signal carries level, confidence, reason", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hello", messageCount: 1 },
    });
    for (const sig of [s.relationshipStrength, s.customerTrust, s.customerFriction]) {
      expect(["low", "medium", "high"]).toContain(sig.level);
      expect(["low", "medium", "high"]).toContain(sig.confidence);
      expect(sig.reason).not.toBe("");
      expect(Array.isArray(sig.evidence)).toBe(true);
    }
  });

  it("signal summaries are appended to provenance.overrides for audit", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "hello", messageCount: 1 },
    });
    expect(s.provenance.overrides.some((o) => o.startsWith("signal.relationshipStrength="))).toBe(true);
    expect(s.provenance.overrides.some((o) => o.startsWith("signal.customerTrust="))).toBe(true);
    expect(s.provenance.overrides.some((o) => o.startsWith("signal.customerFriction="))).toBe(true);
  });

  it("degrades gracefully without recentInboundTexts", () => {
    const s = computeBehaviorState({
      mode: "agent",
      identity: baseIdentity.newLead,
      request: { lastMessage: "are you sure?", messageCount: 2 },
    });
    // Single-message skeptical read still fires; no crash from missing history.
    expect(s.customerTrust.level).toBe("low");
    expect(s.customerFriction.level).toBe("low");
  });

  it("signals are deterministic across runs", () => {
    const input = {
      mode: "agent" as const,
      identity: baseIdentity.customer,
      request: {
        lastMessage: "this is the third time it's still not working",
        messageCount: 6,
        recentInboundTexts: ["still not working", "this is the third time it's still not working"],
      },
    };
    const a = computeBehaviorState(input);
    const b = computeBehaviorState(input);
    expect(a.relationshipStrength).toEqual(b.relationshipStrength);
    expect(a.customerTrust).toEqual(b.customerTrust);
    expect(a.customerFriction).toEqual(b.customerFriction);
  });

  it("PHASE 1 - friction signal alone does NOT alter strategy/tone/escalation", () => {
    // Identical inputs except one carries high-friction language (no flags).
    // Observe-only: strategy, tone, and escalation must be unchanged.
    const base = {
      mode: "agent" as const,
      identity: baseIdentity.newLead,
      request: { lastMessage: "what's the price?", messageCount: 2 },
    };
    const calm = computeBehaviorState(base);
    const frustrated = computeBehaviorState({
      ...base,
      request: {
        ...base.request,
        recentInboundTexts: ["this is ridiculous", "this is awful - what's the price?"],
        lastMessage: "this is awful - what's the price?",
      },
    });
    expect(frustrated.customerFriction.level).toBe("high"); // read changed…
    // …decisions did not.
    expect(frustrated.strategy).toBe(calm.strategy);
    expect(frustrated.toneIntensity).toBe(calm.toneIntensity);
    expect(frustrated.escalationPressure).toBe(calm.escalationPressure);
  });
});
