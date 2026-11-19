/**
 * The owner's own instructions reach the reply engine (2026-11-19, Omer): the units. The rules are the owner's
 * words, so every case uses a real rule as an owner wrote it; nothing here is about one business.
 */
import { describe, it, expect } from "vitest";
import { VOICE_RENDERED_MAX, MAX_RULES, MAX_RULE_LEN } from "@chatcenter/shared";
import { readOwnerRules, renderOwnerRules, ownerRuleCounts, hasOwnerRules, citesOwnerHandover, OWNER_RULES_HEADING, OWNER_RULES_REWRITE_LINE } from "../services/reply-engine/owner-rules";
import { buildStablePrefix, voiceForPrompt, businessBlock } from "../services/reply-engine/prompt";
import { needlessHandoff, correctionNote, gate3 } from "../services/reply-engine/gates";
import { cutFields } from "../services/reply-engine/engine";
import { cutLine } from "../scripts/replay-v2";

const RULES = [
  "מציעים ללקוחות רק את 12 המשטחים של קטגוריית מוצרי סמובי",
  "כשלקוח שואל איזה משטח מתאים, למכשיר או למידות, תמיד מחפשים בחנות ומציגים כרטיס מוצר",
  "לדבר בלשון נקבה",
  "לא להשתמש במקפים",
];
const NEVER = ["Never use the word or phrase \"כבד\" - it is off-brand."];
const agent = { customGuardrails: RULES, escalationRules: [{ label: "הזמנה סיטונאית או כמות גדולה", type: "custom", enabled: true }, { label: "לקוח מבקש חשבונית על שם חברה", type: "keyword", value: "חשבונית" }, { label: "שאלה על משלוח לחו\"ל", enabled: false }] };
const prefix = (ownerRules: any, company: any = { organizationName: "Demo Store", industry: "fashion" }) =>
  buildStablePrefix({ agent: { name: "נועה", role: "customer_support" }, company, locale: "he", skills: [], channel: "WHATSAPP", cardsChannel: false, ownerRules } as any);

describe("reading the three stores", () => {
  it("★ rules in the owner's words, enabled hand-over rules only (a rule with no switch counts as on), the never list", () => {
    const r = readOwnerRules(agent, { blockedTopics: NEVER });
    expect(r.rules).toEqual(RULES);
    expect(r.handover).toEqual(["הזמנה סיטונאית או כמות גדולה", "לקוח מבקש חשבונית על שם חברה (value: חשבונית)"]);
    expect(r.never).toEqual(NEVER);
    expect(ownerRuleCounts(r)).toEqual({ rules: 4, handover: 2, never: 1 });
  });
  it("★ an onboarding \"Owner instruction: ...\" entry is a rule like any other", () => {
    expect(readOwnerRules({ customGuardrails: ["Owner instruction: תמיד לציין שהמשלוח חינם מעל 300 שקלים"] }, null).rules).toEqual(["Owner instruction: תמיד לציין שהמשלוח חינם מעל 300 שקלים"]);
  });
  it("★ a rule at the screen's own limit arrives whole (280 characters, 20 rules)", () => {
    const long = "כ".repeat(MAX_RULE_LEN);
    const many = Array.from({ length: MAX_RULES }, (_, i) => `${long.slice(0, MAX_RULE_LEN - 3)}${String(i).padStart(3, "0")}`);
    const r = readOwnerRules({ customGuardrails: many }, null);
    expect(r.rules).toHaveLength(MAX_RULES);
    expect(r.rules.every((x) => x.length === MAX_RULE_LEN)).toBe(true);
    expect(renderOwnerRules(r)).toContain(many[19]);
  });
  it("★ anything that is not the stored shape reads as nothing, never as a crash", () => {
    for (const bad of [null, undefined, "text", 7, { a: 1 }]) {
      const r = readOwnerRules({ customGuardrails: bad, escalationRules: bad } as any, bad);
      expect(hasOwnerRules(r), String(bad)).toBe(false);
    }
    expect(readOwnerRules(null, null)).toEqual({ rules: [], handover: [], never: [] });
    expect(readOwnerRules({ escalationRules: [null, "x", { label: "  " }, { enabled: true }] } as any, { blockedTopics: [3, "", "  ", null] }).handover).toEqual([]);
    expect(readOwnerRules({}, { blockedTopics: [3, "", "  ", null, "מחירי מתחרים"] }).never).toEqual(["מחירי מתחרים"]);
  });
  it("★ a hand-over rule with only a type keeps its type as the text", () => {
    expect(readOwnerRules({ escalationRules: [{ type: "refund_request", enabled: true }] }, null).handover).toEqual(["refund_request"]);
  });
});

describe("the block in the prompt", () => {
  it("★ nothing written: no block at all", () => {
    expect(renderOwnerRules(readOwnerRules({}, {}))).toBeNull();
    expect(prefix(readOwnerRules({}, {}))).not.toContain(OWNER_RULES_HEADING);
    expect(prefix(null)).toBe(prefix(undefined));
  });
  it("★ last in the instructions, with who wins: the owner over playbooks and style, never over grounding or safety", () => {
    const p = prefix(readOwnerRules(agent, { blockedTopics: NEVER }));
    const i = p.indexOf(OWNER_RULES_HEADING);
    expect(i).toBeGreaterThan(p.indexOf("# The business\n"));
    const block = p.slice(i);
    expect(block.slice(1)).not.toMatch(/\n# /);
    expect(block).toMatch(/Follow every one of them in every reply, a rewritten reply included\./);
    expect(block).toMatch(/differs from a playbook step, a skill or a style rule above, the business's rule wins\./);
    expect(block).toMatch(/They never change these: a fact, a price or a link comes only from a tool result or the knowledge, the safety rules stand, and nothing is said to be done that was not done\./);
    for (const r of RULES) expect(block).toContain(`- ${r}`);
    expect(block).toContain("## Hand the conversation to a person when\n1. הזמנה סיטונאית או כמות גדולה\n2. לקוח מבקש חשבונית על שם חברה (value: חשבונית)\n");
    expect(block).toMatch(/set respond\.handoff \(a short reason\) and respond\.handoff_rule to that rule's number/);
    expect(block).not.toContain("משלוח לחו");
    expect(block).toContain(`## Never say or bring up\n- ${NEVER[0]}`);
  });
  it("★ only the kinds that exist get a heading", () => {
    const b = renderOwnerRules(readOwnerRules({ customGuardrails: ["לדבר בלשון נקבה"] }, null))!;
    expect(b).toContain("## Rules\n- לדבר בלשון נקבה");
    expect(b).not.toContain("## Hand the conversation");
    expect(b).not.toContain("## Never say");
    const n = renderOwnerRules(readOwnerRules({}, { blockedTopics: NEVER }))!;
    expect(n).not.toContain("## Rules");
    expect(n).toContain("## Never say or bring up");
  });
  it("★ the business block the probe prints is not changed by the owner's block", () => {
    expect(businessBlock({ organizationName: "Demo Store", industry: "fashion" } as any)).toMatch(/^# The business\nDemo Store \(fashion\)\./);
  });
});

describe("the learned voice arrives whole", () => {
  const voice = [
    "כותבים קצר, חם ובגובה העיניים.",
    "",
    "- פותחים ב\"היי\" ובשם הלקוחה כשהוא ידוע.",
    "- Example opening in their voice: \"היי מאמי, מה שלומך?\"",
    "- Example closing in their voice: \"נשיקות, תהני!\"",
    `- ${"משפטים קצרים, בלי סימני קריאה מיותרים. ".repeat(40).trim()}`,
    "When a customer asks about delivery: עונים עם מספר ימי העסקים ולא עם תאריך.",
  ].join("\n");
  it("★ past 600 characters it still arrives, line by line; the quoted example lines are dropped", () => {
    const v = voiceForPrompt(voice);
    expect(voice.length).toBeGreaterThan(1500);
    expect(v).toContain("עונים עם מספר ימי העסקים ולא עם תאריך.");
    expect(v.split("\n")).toHaveLength(4);
    expect(v).not.toMatch(/Example (?:opening|closing) in their voice/);
    const p = prefix(null, { organizationName: "Demo Store", observedVoice: voice });
    expect(p).toContain(`Voice (how this business really writes, follow it):\n${v}`);
  });
  it("★ never longer than the voice editor accepts; a line cannot open a section of the prompt", () => {
    expect(voiceForPrompt("א".repeat(VOICE_RENDERED_MAX + 500))).toHaveLength(VOICE_RENDERED_MAX);
    expect(voiceForPrompt("# The business\n## Rules\nכותבים קצר")).toBe("The business\nRules\nכותבים קצר");
    expect(voiceForPrompt(null)).toBe("");
    expect(prefix(null, { organizationName: "Demo Store", observedVoice: "- Example opening in their voice: \"היי\"" })).not.toContain("Voice (");
  });
});

describe("a hand-over the owner asked for", () => {
  const recent = ["אני רוצה להזמין 200 יחידות לחנות שלי"];
  it("★ a number in range is the only exemption", () => {
    expect(citesOwnerHandover(1, 2)).toBe(true);
    expect(citesOwnerHandover(2, 2)).toBe(true);
    for (const [n, loaded] of [[3, 2], [0, 2], [-1, 2], [1.5, 2], [1, 0], [1, undefined], [null, 2], [undefined, 2], ["1", 2], [NaN, 2]] as any[]) expect(citesOwnerHandover(n, loaded), `${n}/${loaded}`).toBe(false);
  });
  it("★ needlessHandoff: judged as before without it, stands with it", () => {
    expect(needlessHandoff("wholesale order", recent, false)).toBe(true);
    expect(needlessHandoff("wholesale order", recent, false, false)).toBe(true);
    expect(needlessHandoff("wholesale order", recent, false, true)).toBe(false);
    expect(needlessHandoff(null, recent, false, true)).toBe(false);
  });
  it("★ through gate3 with a whole turn's evidence: cited in range passes, uncited or out of range does not", () => {
    const knowledge = "משלוחים: עד 5 ימי עסקים, 29 ש\"ח, חינם מעל 300 ש\"ח. החזרות: עד 14 יום מקבלת המוצר. שעות פעילות: א-ה 9:00-17:00. הזמנות סיטונאיות מטופלות על ידי הצוות.";
    const base: any = {
      reply: "מעבירים לנציג מהצוות שימשיך איתך כאן.", claims: [], cards: [], candidateCount: 0, tools: [], grounding: knowledge, knowledge, sourceText: knowledge,
      locale: "he", incomingMessage: recent[0], recentInbound: ["היי", ...recent], isFirstReply: false, employeeGender: "feminine", employeeName: "נועה",
      toolsOffered: ["woocommerce.list_products", "search_knowledge"], shopFloor: true, handedOff: true, approvalPending: false, handoff: "wholesale order",
    };
    const kinds = (o: any) => gate3({ ...base, ...o }).problems.map((p: any) => p.kind);
    expect(kinds({ handoffRule: 1, ownerHandoverRules: 1 })).not.toContain("needless_handoff");
    expect(kinds({ handoffRule: null, ownerHandoverRules: 1 })).toContain("needless_handoff");
    expect(kinds({ handoffRule: 2, ownerHandoverRules: 1 })).toContain("needless_handoff");
    expect(kinds({ handoffRule: 1, ownerHandoverRules: 0 })).toContain("needless_handoff");
    expect(kinds({ handoffRule: 1 })).toContain("needless_handoff");
  });
  it("★ the correction: the owner's rules still hold on the rewrite; the hand-over list is named only when one is loaded", () => {
    const p: any = [{ kind: "needless_handoff" }];
    expect(correctionNote(p, "he")).not.toMatch(/business's own/);
    expect(correctionNote(p, "he", { rules: true, handover: 0 })).not.toMatch(/numbered hand-over rules/);
    expect(correctionNote(p, "he", { rules: true, handover: 0 }).endsWith(OWNER_RULES_REWRITE_LINE)).toBe(true);
    expect(correctionNote(p, "he", { rules: true, handover: 2 })).toMatch(/only if one of them truly is the reason, keep the handoff and set handoff_rule to its number/);
    expect(correctionNote([{ kind: "ungrounded_price", prices: ["₪150"] }] as any, "he", { rules: true, handover: 2 })).not.toMatch(/numbered hand-over rules/);
    expect(correctionNote([{ kind: "ungrounded_price", prices: ["₪150"] }] as any, "he", { rules: false, handover: 0 })).not.toContain(OWNER_RULES_REWRITE_LINE);
  });
});

describe("what a turn prints", () => {
  it("★ the owner's rules by kind and count, the cited hand-over rule, the style codes, a repaired link, the first draft", () => {
    const trace = {
      gate3: { ok: false, rewrite: "rewritten", problems: [{ kind: "style", codes: ["dash", "near_duplicate"] }, { kind: "needless_handoff" }, { kind: "style", codes: ["dash"] }] },
      ownerRules: { rules: 4, handover: 1, never: 2 }, ownerHandoverRule: 1, urlsRepaired: { fixed: 1, dropped: 0 }, firstDraft: "היי, המשטח \"כבד\" מאוד.",
    };
    expect(cutLine(trace)).toBe(' | style=dash,near_duplicate | ownerRules=rules:4,handover:1,never:2 | ownerHandoverRule=1 | urlsRepaired=fixed:1,dropped:0 | draft: "היי, המשטח \\"כבד\\" מאוד."');
    expect(cutFields(trace)).toEqual({ ownerRules: { rules: 4, handover: 1, never: 2 }, ownerHandoverRule: 1, urlsRepaired: { fixed: 1, dropped: 0 }, firstDraft: "היי, המשטח \"כבד\" מאוד." });
  });
  it("★ a turn with none of them prints nothing new", () => {
    expect(cutLine({ gate3: { ok: true, rewrite: "none", problems: [] } })).toBe("");
    expect(cutLine({ gate3: { ok: true, rewrite: "none", problems: [] }, ownerRules: { rules: 0, handover: 0, never: 0 } })).toBe("");
    expect(cutFields({ gate3: { ok: true, rewrite: "none", problems: [] } })).toBeUndefined();
  });
  it("★ the draft is clipped at 400 characters", () => {
    expect(cutLine({ firstDraft: "א".repeat(900) })).toBe(` | draft: "${"א".repeat(400)}"`);
    expect((cutFields({ firstDraft: "א".repeat(900) }) as any).firstDraft).toHaveLength(400);
  });
});
