import { describe, it, expect } from "vitest";
import {
  computeProspectState,
  renderProspectState,
} from "../services/prospect-state";
import {
  selectActiveObjective,
  commitObjective,
  type ActiveGoalSnapshot,
  renderObjectiveLedger,
  isPassiveCloser,
  customerIsClosing,
  buildCloserCorrective,
  OBJECTIVE_CHAINS,
  resolveNextActions,
  hasViableAdvancingAction,
  guaranteedBackgroundActions,
  objectivePriority,
  renderOutcomePriority,
  renderQualifyOutDirective,
  isCreationToolAllowed,
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

  it("EARLY PROMOTION: scheduling intent + an email (no name) promotes BOOK_MEETING immediately", () => {
    // The trust-eroding window: the customer is actively booking and gave an
    // email, but the name/need weren't extracted. BOOK_MEETING must activate NOW
    // (required booking inputs present) instead of stalling on lead identity.
    const facts = '- "אפשר לקבוע דמו למחר ב-16:30?"\n- e2e@example.com';
    const s = selectActiveObjective("sales", "NEW_PROSPECT", facts);
    expect(s?.objective.id).toBe("BOOK_MEETING");
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

  it("a NEW prospect (no CRM flags) renders the Current Plan with GENERATE_LEAD as the goal", () => {
    const p = prompt(undefined);
    expect(p).toContain("# Current Plan");
    expect(p).toContain("objective GENERATE_LEAD");
    expect(p).toContain("NEW_PROSPECT");
    // Missing required fields surfaced by their human labels (not raw keys). The
    // name is known from the customer block, so an actually-missing field shows.
    expect(p).toContain("Still needed for the goal");
    expect(p).toContain("what their business does");
    expect(p).toMatch(/Best next action/);
  });

  it("a known customer renders CUSTOMER situation and QUALIFY_LEAD as the active objective", () => {
    const p = prompt({ hasLead: true, hasContact: true, isCustomer: true });
    expect(p).toContain("# Current Plan");
    expect(p).toContain("CUSTOMER");
    expect(p).toContain("objective QUALIFY_LEAD");
    // Lead generation is skipped — it must NOT be the active objective.
    expect(p).not.toContain("objective GENERATE_LEAD");
  });
});

describe("Next-Best-Action resolver (the decision layer)", () => {
  it("BOOK_MEETING with all info captured + bookable → top action is ACT schedule_meeting", () => {
    // need (QUALIFY_LEAD) satisfied so the chain reaches BOOK_MEETING, plus the
    // booking requirements (meeting interest + email).
    const factText =
      "- Name: Omer\n- email: omer@x.com\n- need: lots of missed WhatsApp leads\n- wants a demo\n- meeting: yes";
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", factText);
    const actions = resolveNextActions({
      status,
      capability: ["schedule_meeting", "escalate_to_human"],
      calendarBookable: true,
    });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].kind).toBe("act");
    expect(actions[0].tool).toBe("schedule_meeting");
    expect(hasViableAdvancingAction(actions)).toBe(true);
  });

  it("missing email → top action is to PROPOSE/ASK, never ACT schedule_meeting", () => {
    const factText = "- Name: Omer\n- need: missed leads\n- wants a demo";
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", factText);
    const actions = resolveNextActions({
      status,
      capability: ["schedule_meeting", "escalate_to_human"],
      calendarBookable: true,
    });
    // schedule_meeting must NOT be an ACT candidate while email is missing.
    expect(actions.find((a) => a.kind === "act" && a.tool === "schedule_meeting")).toBeUndefined();
    expect(actions.some((a) => a.kind === "ask" || a.kind === "propose")).toBe(true);
  });

  it("calendar NOT bookable → never proposes/acts a booking; escalate stays last", () => {
    const factText = "- Name: Omer\n- email: omer@x.com\n- need: missed leads\n- meeting: yes";
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", factText);
    const actions = resolveNextActions({
      status,
      capability: ["escalate_to_human"], // no schedule_meeting in surface
      calendarBookable: false,
    });
    expect(actions.find((a) => a.tool === "schedule_meeting")).toBeUndefined();
    // escalate is always present but deprioritized (lowest score → last).
    expect(actions[actions.length - 1].kind).toBe("escalate");
  });

  it("all objectives complete → empty shortlist (model may close)", () => {
    const actions = resolveNextActions({ status: null, capability: ["schedule_meeting"], calendarBookable: true });
    expect(actions).toEqual([]);
    expect(hasViableAdvancingAction(actions)).toBe(false);
  });
});

describe("Action-complete vs info-complete (BOOK_MEETING)", () => {
  // meeting agreed + email present: info is complete, but no booking happened.
  const bookedReadyFacts = "- Name: Omer\n- email: omer@x.com\n- need: missed leads\n- meeting: yes";

  it("info ready but NOT yet booked → BOOK_MEETING stays ACTIVE (don't skip the booking)", () => {
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", bookedReadyFacts, [], true);
    expect(status?.objective.id).toBe("BOOK_MEETING");
  });

  it("schedule_meeting already SUCCEEDED → BOOK_MEETING completes, chain advances", () => {
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", bookedReadyFacts, ["schedule_meeting"], true);
    expect(status?.objective.id).not.toBe("BOOK_MEETING");
  });

  it("non-bookable agent → BOOK_MEETING falls back to info-complete (never stalls)", () => {
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", bookedReadyFacts, [], false);
    expect(status?.objective.id).not.toBe("BOOK_MEETING");
  });
});

describe("Goal Commitment / persistent ownership (Unit A)", () => {
  const bookGoal: ActiveGoalSnapshot = {
    objectiveId: "BOOK_MEETING",
    stepIndex: 2, // SALES chain: GENERATE_LEAD, QUALIFY_LEAD, BOOK_MEETING, CREATE_DEAL
    achieved: ["meeting_interest", "attendee_email"],
    missingRequired: [],
    stalledTurns: 0,
  };

  it("no prior goal → commits the fresh selection unchanged (back-compat)", () => {
    const fresh = selectActiveObjective("sales", "NEW_PROSPECT", "");
    const { status, snapshot } = commitObjective(null, fresh, "");
    expect(status?.objective.id).toBe("GENERATE_LEAD");
    expect(snapshot?.objectiveId).toBe("GENERATE_LEAD");
    expect(snapshot?.stalledTurns).toBe(0);
  });

  it("fresh==null (chain complete) → no active goal", () => {
    const { status, snapshot } = commitObjective(bookGoal, null, "");
    expect(status).toBeNull();
    expect(snapshot).toBeNull();
  });

  it("ANTI-REGRESSION: committed BOOK_MEETING is HELD when this turn's facts regress to QUALIFY_LEAD", () => {
    // The customer's latest message dropped the booking signal → stateless
    // selection falls back to QUALIFY_LEAD (step 1). Ownership must hold BOOK.
    const fresh = selectActiveObjective("sales", "KNOWN_CONTACT", "");
    expect(fresh?.objective.id).toBe("QUALIFY_LEAD"); // proves the regression exists
    const { status, snapshot } = commitObjective(bookGoal, fresh, "");
    expect(status?.objective.id).toBe("BOOK_MEETING"); // …but the goal is held
    expect(snapshot?.objectiveId).toBe("BOOK_MEETING");
    // achieved stays sticky → the gap is not re-opened on the transient loss.
    expect(status?.missingRequired).toEqual([]);
    expect(snapshot?.stalledTurns).toBe(1); // held with no progress → stall ticks
  });

  it("ADVANCE: committed QUALIFY_LEAD yields to a forward jump to BOOK_MEETING", () => {
    const prior: ActiveGoalSnapshot = {
      objectiveId: "QUALIFY_LEAD", stepIndex: 1, achieved: ["need"], missingRequired: [], stalledTurns: 0,
    };
    const facts = "- Name: Omer\n- email: omer@x.com\n- need: missed leads\n- wants a demo\n- meeting: yes";
    const fresh = selectActiveObjective("sales", "KNOWN_CONTACT", facts);
    expect(fresh?.objective.id).toBe("BOOK_MEETING");
    const { status } = commitObjective(prior, fresh, facts);
    expect(status?.objective.id).toBe("BOOK_MEETING"); // forward progress adopted
  });

  it("RELEASE valve: a goal stalled past the threshold stops being force-held", () => {
    const stalled: ActiveGoalSnapshot = { ...bookGoal, stalledTurns: 3 };
    const fresh = selectActiveObjective("sales", "KNOWN_CONTACT", "");
    expect(fresh?.objective.id).toBe("QUALIFY_LEAD");
    const { status } = commitObjective(stalled, fresh, "");
    expect(status?.objective.id).toBe("QUALIFY_LEAD"); // released → natural selection
  });

  it("STICKY gap: a required field once achieved is not re-listed after it drops from facts", () => {
    // Same objective continuing; this turn 'need' fell out of the fact text.
    const prior: ActiveGoalSnapshot = {
      objectiveId: "QUALIFY_LEAD", stepIndex: 1, achieved: ["need"], missingRequired: [], stalledTurns: 0,
    };
    const fresh = selectActiveObjective("sales", "KNOWN_CONTACT", ""); // need missing now
    expect(fresh?.objective.id).toBe("QUALIFY_LEAD");
    expect(fresh?.missingRequired).toContain("need"); // stateless view re-opens it
    const { status, snapshot } = commitObjective(prior, fresh, "");
    expect(status?.missingRequired).not.toContain("need"); // ownership keeps it satisfied
    expect(snapshot?.achieved).toContain("need");
  });

  it("ACTION PREFERENCE (Unit B): a HELD goal still surfaces its RIPE act this turn", () => {
    // Unit A holds BOOK_MEETING through a fact regression; Unit B's trigger is
    // `resolveNextActions(...).find(kind==='act')` on that committed status. The
    // held goal (all required inputs sticky-achieved) must yield a RIPE act so
    // the agent prefers booking over the non-advancing reply.
    const fresh = selectActiveObjective("sales", "KNOWN_CONTACT", ""); // regressed to QUALIFY
    const { status: held } = commitObjective(bookGoal, fresh, "");
    expect(held?.objective.id).toBe("BOOK_MEETING"); // ownership held it (Unit A)
    const ripe = resolveNextActions({
      status: held,
      capability: ["schedule_meeting", "escalate_to_human"],
      calendarBookable: true,
    }).find((c) => c.kind === "act");
    expect(ripe?.tool).toBe("schedule_meeting"); // RIPE act exists → Unit B would force it
  });

  it("ACTION PREFERENCE (Unit B): NO RIPE act when the booking tool is not dispatchable", () => {
    // Capability gate: not bookable / tool absent → no `act` candidate → Unit B
    // stays out (it can never force an action the agent cannot perform).
    const { status: held } = commitObjective(bookGoal, selectActiveObjective("sales", "KNOWN_CONTACT", ""), "");
    const ripe = resolveNextActions({
      status: held,
      capability: ["escalate_to_human"], // schedule_meeting NOT surfaced
      calendarBookable: false,
    }).find((c) => c.kind === "act");
    expect(ripe).toBeUndefined();
  });
});

describe("Guaranteed background actions (deterministic CRM integrity)", () => {
  // GENERATE_LEAD info-complete (name + business_type + contact_method) for a NEW
  // prospect whose lead was never created → create_lead must be guaranteed.
  const leadReady = "- Name: Yossi\n- industry: retail\n- email: y@x.com\n- interest: faster replies";

  it("info-complete NEW prospect with no lead yet → forces integration_create_lead", () => {
    const acts = guaranteedBackgroundActions({
      role: "sales", prospectState: "NEW_PROSPECT", factText: leadReady, committedTools: [],
    });
    expect(acts.some((a) => a.tool === "integration_create_lead")).toBe(true);
  });

  it("already created this conversation → not forced again", () => {
    const acts = guaranteedBackgroundActions({
      role: "sales", prospectState: "NEW_PROSPECT", factText: leadReady,
      committedTools: ["integration_create_lead"],
    });
    expect(acts.some((a) => a.tool === "integration_create_lead")).toBe(false);
  });

  it("lead already exists (prospect not NEW) → no redundant create", () => {
    const acts = guaranteedBackgroundActions({
      role: "sales", prospectState: "KNOWN_CONTACT", factText: leadReady, committedTools: [],
    });
    expect(acts.some((a) => a.tool === "integration_create_lead")).toBe(false);
  });

  it("required info still missing → not yet ripe, not forced", () => {
    const acts = guaranteedBackgroundActions({
      role: "sales", prospectState: "NEW_PROSPECT", factText: "- Name: Yossi", committedTools: [],
    });
    expect(acts.some((a) => a.tool === "integration_create_lead")).toBe(false);
  });
});

describe("Goal prioritization (business-outcome layer)", () => {
  it("booking/conversion outrank capture/resolution; informational has no weight", () => {
    expect(objectivePriority("BOOK_MEETING")).toBeGreaterThan(objectivePriority("QUALIFY_LEAD"));
    expect(objectivePriority("CREATE_DEAL")).toBeGreaterThan(objectivePriority("GENERATE_LEAD"));
    expect(objectivePriority("RESOLVE_ISSUE")).toBeGreaterThan(objectivePriority("GENERATE_LEAD"));
    expect(objectivePriority(undefined)).toBe(0); // no goal → no priority (pure chat loses)
  });

  it("renders an outcome-priority directive for the active objective", () => {
    const s = selectActiveObjective("sales", "KNOWN_CONTACT", "")!;
    const md = renderOutcomePriority(s)!;
    expect(md).toContain("Business-outcome priority");
    expect(md.toLowerCase()).toContain("outrank");
    expect(renderOutcomePriority(null)).toBeNull();
  });
});

describe("Wizard→Runtime: structured facts consumed by the engine (no heuristics)", () => {
  // goalObjective truncates the chain at the configured endpoint — the engine
  // never pursues objectives BEYOND the configured goal, and never SKIPS earlier
  // capture/qualify steps.
  it("goalObjective=BOOK_MEETING → engine stops at booking, never reaches CREATE_DEAL", () => {
    // All sales info present + booked → without truncation the next objective is
    // CREATE_DEAL; with goalObjective=BOOK_MEETING the chain ends → ALL_COMPLETE.
    const facts = "- Name: A\n- email: a@x.com\n- need: x\n- meeting: yes";
    const truncated = selectActiveObjective("sales", "KNOWN_CONTACT", facts, ["schedule_meeting"], true, "BOOK_MEETING");
    expect(truncated).toBeNull(); // booking done + chain ends at BOOK_MEETING → complete
    // Without truncation, CREATE_DEAL would still be active.
    const full = selectActiveObjective("sales", "KNOWN_CONTACT", facts, ["schedule_meeting"], true, null);
    expect(full?.objective.id).toBe("CREATE_DEAL");
  });

  it("goalObjective never skips earlier steps (still captures the lead first)", () => {
    const s = selectActiveObjective("sales", "NEW_PROSPECT", "", [], true, "BOOK_MEETING");
    expect(s?.objective.id).toBe("GENERATE_LEAD"); // endpoint set, but capture still first
  });

  it("qualificationMet=false suppresses the proactive demo PROPOSE while qualifying", () => {
    const status = selectActiveObjective("sales", "KNOWN_CONTACT", ""); // need missing → QUALIFY active
    expect(status?.objective.id).toBe("QUALIFY_LEAD");
    const gated = resolveNextActions({ status, capability: ["schedule_meeting"], calendarBookable: true, qualificationMet: false });
    expect(gated.some((c) => c.kind === "propose")).toBe(false);
    const open = resolveNextActions({ status, capability: ["schedule_meeting"], calendarBookable: true, qualificationMet: true });
    expect(open.some((c) => c.kind === "propose")).toBe(true);
  });

  it("qualify-out directive names the matched signal and steers AWAY from forcing a demo", () => {
    const md = renderQualifyOutDirective("students looking for free tools");
    expect(md).toContain("students looking for free tools");
    expect(md.toLowerCase()).toContain("qualify out");
    expect(md.toLowerCase()).toContain("do not push");
  });
});

describe("Goal progress > info collection (generic anti-loop)", () => {
  // When stalled, the same required field must NOT be re-asked; a forward move
  // outranks it. Role-agnostic — keys off the objective's requiredInformation.
  it("stalled=true suppresses the repeated ASK and surfaces a higher-scored forward move", () => {
    const status = selectActiveObjective("sales", "NEW_PROSPECT", ""); // GENERATE_LEAD, missing name
    const normal = resolveNextActions({ status, capability: [], calendarBookable: false, stalled: false });
    const stalled = resolveNextActions({ status, capability: [], calendarBookable: false, stalled: true });
    expect(normal.some((c) => c.kind === "ask")).toBe(true);          // normally asks
    expect(stalled.some((c) => c.kind === "ask")).toBe(false);        // stalled → stop asking
    const top = stalled.sort((a, b) => b.score - a.score)[0];
    expect(top.kind).not.toBe("ask");                                 // a forward move wins
    expect(top.kind).not.toBe("escalate");                            // and it's not a handoff
  });
});

describe("Outcome quality > data collection (generic creation gate)", () => {
  it("blocks ALL creation for a disqualified prospect", () => {
    const ctx = { fit: "disqualified" as const, prospectState: "KNOWN_CONTACT" as const };
    expect(isCreationToolAllowed("integration_create_lead", ctx)).toBe(false);
    expect(isCreationToolAllowed("integration_create_deal", ctx)).toBe(false);
  });
  it("blocks a commitment object (deal) for an anonymous NEW prospect — the live bug", () => {
    const ctx = { fit: "neutral" as const, prospectState: "NEW_PROSPECT" as const };
    expect(isCreationToolAllowed("integration_create_deal", ctx)).toBe(false);   // no deal for anon/hostile
    expect(isCreationToolAllowed("integration_create_lead", ctx)).toBe(true);    // capture still allowed
    expect(isCreationToolAllowed("schedule_meeting", ctx)).toBe(true);           // non-creation untouched
  });
  it("allows a deal once a real contact exists", () => {
    const ctx = { fit: "qualified" as const, prospectState: "KNOWN_CONTACT" as const };
    expect(isCreationToolAllowed("integration_create_deal", ctx)).toBe(true);
  });
});
