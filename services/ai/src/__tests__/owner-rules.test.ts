/**
 * The owner's own instructions reach the reply engine (2026-11-19, Omer): the units. The rules are the owner's
 * words, so every case uses a real rule as an owner wrote it; nothing here is about one business.
 */
import { describe, it, expect } from "vitest";
import { VOICE_RENDERED_MAX, MAX_RULES, MAX_RULE_LEN } from "@chatcenter/shared";
import { readOwnerRules, renderOwnerRules, ownerRuleCounts, hasOwnerRules, citesOwnerHandover, neverSaid, ownerAddressForm, OWNER_RULES_HEADING, OWNER_RULES_REWRITE_LINE } from "../services/reply-engine/owner-rules";
import { buildStablePrefix, voiceForPrompt, businessBlock } from "../services/reply-engine/prompt";
import { needlessHandoff, correctionNote, gate3, stripFactProblems, factualProblems, neutralSecondPerson } from "../services/reply-engine/gates";
import { checkReplyStyle, addressFormsUsed } from "../services/reply-style-check.service";
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

describe("the never list is enforced (2026-11-19: never = [\"זול\"], and \"הכי זול שמצאנו\" went out)", () => {
  it("★ an entry is found as a whole word, with the particles Hebrew attaches to it", () => {
    for (const said of ["הכי זול שמצאנו הוא גופיית כותנה, ויש גם חולצת טי במחיר נמוך.", "זה המוצר הזול ביותר שלנו", "אפשר למצוא אצלנו גם בזול", "איכותי וזול", "זול!", "\"זול\" זה לא"]) expect(neverSaid(said, ["זול"]), said).toEqual(["זול"]);
    // Another word that holds its letters is not the entry.
    for (const other of ["יש לנו פריטים במחירים נגישים", "זולת המשלוח אין עלות נוספת", "הפריט מוזל השבוע", "זולים", ""]) expect(neverSaid(other, ["זול"]), other).toEqual([]);
  });
  it("★ a two-letter Hebrew entry takes no particle (\"בקר\" is not \"קר\")", () => {
    expect(neverSaid("ארוחת בקר מוגשת עד 11", ["קר"])).toEqual([]);
    expect(neverSaid("המשקה מוגש קר", ["קר"])).toEqual(["קר"]);
  });
  it("★ a phrase, an English word in any case, quotes of any kind; one letter is no entry", () => {
    expect(neverSaid("אנחנו לא משווים מחירי  מתחרים", ["מחירי מתחרים"])).toEqual(["מחירי מתחרים"]);
    expect(neverSaid("לא משווים מחירים של מתחרים", ["מחירי מתחרים"])).toEqual([]);
    expect(neverSaid("It is a Cheap one.", ["cheap"])).toEqual(["cheap"]);
    expect(neverSaid("This is the cheapest one.", ["cheap"])).toEqual([]);
    expect(neverSaid("קוראים לזה ״דיל״ אצלנו", ["\"דיל\""])).toEqual(["\"דיל\""]);
    expect(neverSaid("a table and a chair", ["a"])).toEqual([]);
    expect(neverSaid("מחיר (כולל מע\"מ) ומשלוח", ["(כולל מע\"מ)"])).toEqual(["(כולל מע\"מ)"]);
    expect(neverSaid("זול ומבצע", ["מבצע", "יקר", "זול"])).toEqual(["מבצע", "זול"]);
    expect(neverSaid("זול", null)).toEqual([]);
  });
  const base: any = { claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", knowledge: "", sourceText: "", locale: "he", incomingMessage: "זה נשמע לי לא זול בכלל", recentInbound: ["זה נשמע לי לא זול בכלל"], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false };
  const REPLY = "מבינים, זה באמת לא זול. אפשר לבדוק יחד מה מתאים לתקציב שלך.";
  it("★ gate3: the entry in the reply is a problem that names it, also when the customer wrote the word herself; it can stop a reply", () => {
    const v = gate3({ ...base, reply: REPLY, never: ["יקר", "זול"] });
    expect(v.problems).toEqual([{ kind: "owner_never", claims: ["זול"] }]);
    expect(factualProblems(v.problems)).toHaveLength(1);
    expect(gate3({ ...base, reply: REPLY, never: [] }).ok).toBe(true);
    expect(gate3({ ...base, reply: REPLY }).ok).toBe(true);
    expect(gate3({ ...base, reply: "מבינים. אפשר לבדוק יחד מה מתאים לתקציב שלך.", never: ["זול"] }).ok).toBe(true);
  });
  it("★ the cut takes the sentence that says it and nothing else", () => {
    expect(stripFactProblems(REPLY, [{ kind: "owner_never", claims: ["זול"] }])).toBe("אפשר לבדוק יחד מה מתאים לתקציב שלך.");
    expect(stripFactProblems("זולת המשלוח אין עלות. זה לא זול.", [{ kind: "owner_never", claims: ["זול"] }])).toBe("זולת המשלוח אין עלות.");
  });
  it("★ the correction names every entry said, and the printout carries the count", () => {
    const note = correctionNote([{ kind: "owner_never", claims: ["זול", "מבצע"] }], "he", { rules: true, handover: 0 });
    expect(note).toContain('- The business never says this: "זול", "מבצע". Your reply says it. Write the reply again without those words');
    expect(correctionNote([{ kind: "owner_never", claims: ["זול"] }], "he")).toContain("without that word or phrase");
    expect(cutLine({ neverListHit: 2 })).toBe(" | neverListHit=2");
    expect(cutFields({ neverListHit: 2 })).toEqual({ neverListHit: 2 });
  });
});

describe("the owner sets how the customer is addressed (2026-11-19: the rule \"לפנות אל הלקוח בלשון נקבה בלבד\", and the draft's \"תרצי?\" was flagged and rewritten away)", () => {
  it("★ a rule sets the form only when it says it is about addressing the customer and names the form", () => {
    expect(ownerAddressForm(["לפנות אל הלקוח בלשון נקבה בלבד"])).toBe("feminine");
    expect(ownerAddressForm(["לא להשתמש במקפים", "פנייה ללקוחות בנקבה"])).toBe("feminine");
    expect(ownerAddressForm(["מדברים עם הלקוחות בגוף נקבה"])).toBe("feminine");
    expect(ownerAddressForm(["תמיד פונים בלשון זכר"])).toBe("masculine");
    expect(ownerAddressForm(["כותבים ללקוח בלשון זכר"])).toBe("masculine");
    expect(ownerAddressForm(["Address the customer in the feminine form"])).toBe("feminine");
    expect(ownerAddressForm(["Always speak to customers in the masculine form."])).toBe("masculine");
  });
  it("★ every other rule sets nothing, and the neutral address stays", () => {
    // Whose speech? The employee's own voice is as likely, and no customer is named.
    expect(ownerAddressForm(["לדבר בלשון נקבה"])).toBeNull();
    expect(ownerAddressForm(["הנציגה כותבת ללקוח על עצמה בלשון נקבה"])).toBeNull();
    // The customer is named, and the form is still the employee's own.
    expect(ownerAddressForm(["לכתוב ללקוחות על עצמך בלשון נקבה"])).toBeNull();
    expect(ownerAddressForm(["When you write to customers, refer to yourself in the feminine form"])).toBeNull();
    // An address rule that names no form, and a form that is not about address.
    expect(ownerAddressForm(["לפנות אל הלקוח בנימוס ובשמו הפרטי"])).toBeNull();
    expect(ownerAddressForm(["תיאורי המוצרים באתר בלשון נקבה"])).toBeNull();
    // A rule that forbids, and both forms (in one rule, or across two).
    expect(ownerAddressForm(["לא לפנות אל הלקוח בלשון זכר"])).toBeNull();
    expect(ownerAddressForm(["אסור לפנות ללקוחות בלשון נקבה"])).toBeNull();
    expect(ownerAddressForm(["לפנות ללקוח בלשון זכר או בלשון נקבה לפי השם"])).toBeNull();
    expect(ownerAddressForm(["לפנות אל הלקוח בלשון נקבה ולא בלשון זכר"])).toBeNull();
    expect(ownerAddressForm(["לפנות אל הלקוח בלשון נקבה", "פונים ללקוחות בלשון זכר"])).toBeNull();
    expect(ownerAddressForm(["Never address the customer in the feminine form"])).toBeNull();
    expect(ownerAddressForm([])).toBeNull();
    expect(ownerAddressForm(null)).toBeNull();
  });
  it("★ the forms a reply uses towards the customer, each by its first word", () => {
    expect(addressFormsUsed("כן, יש בכחול. תרצי לראות?")).toEqual({ masculine: null, feminine: "תרצי" });
    expect(addressFormsUsed("כן, יש בכחול. תרצה לראות?")).toEqual({ masculine: "תרצה", feminine: null });
    expect(addressFormsUsed("את רוצה לראות עוד צבעים?")).toEqual({ masculine: null, feminine: "את רוצה" });
    expect(addressFormsUsed("אתה רוצה לראות עוד צבעים?")).toEqual({ masculine: "אתה רוצה", feminine: null });
    // "את" after a masculine participle is the object marker, not "you".
    expect(addressFormsUsed("מחפש את המעיל הכחול?").feminine).toBeNull();
    expect(addressFormsUsed("מחפש את המעיל הכחול?").masculine).toContain("מחפש");
    expect(addressFormsUsed("מחפשת מעיל לחורף?").masculine).toBeNull();
    expect(addressFormsUsed("מחפשת מעיל לחורף?").feminine).toContain("מחפשת");
    expect(addressFormsUsed("שלחי לי תמונה ותוכל לבחור.")).toEqual({ masculine: "ותוכל", feminine: "שלחי" });
    // A participle that opens a clause inside a question, and one after a question word.
    expect(addressFormsUsed("יותר מתאים לשכבות או מעדיף משהו חם?")).toEqual({ masculine: "או מעדיף", feminine: null });
    expect(addressFormsUsed("זה יותר לשכבות, מעדיפה משהו חם?").masculine).toBeNull();
    expect(addressFormsUsed("זה יותר לשכבות, מעדיפה משהו חם?").feminine).toContain("מעדיפה");
    // A bare order.
    expect(addressFormsUsed("שלח לי את מספר ההזמנה.")).toEqual({ masculine: "שלח", feminine: null });
    expect(addressFormsUsed("שלחי לי את מספר ההזמנה.")).toEqual({ masculine: null, feminine: "שלחי" });
    expect(addressFormsUsed("אפשר לבחור צבע ולראות את כל המידות.")).toEqual({ masculine: null, feminine: null });
  });

  const base: any = { claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", knowledge: "", sourceText: "", locale: "he", incomingMessage: "תודה על העזרה", recentInbound: ["תודה על העזרה"], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false };
  const codes = (reply: string, ownerAddress?: any) => gate3({ ...base, reply, ownerAddress }).problems.filter((p: any) => p.kind === "style").flatMap((p: any) => p.codes);
  it("★ gate3: the owner's form is no fault, the other form still is; with no address rule both are, as today", () => {
    const fem = "בשמחה. תרצי שנעבור יחד על האפשרויות?";
    const masc = "בשמחה. תרצה שנעבור יחד על האפשרויות?";
    expect(codes(fem)).toEqual(["gendered_address"]);
    expect(codes(masc)).toEqual(["gendered_address"]);
    expect(codes(fem, null)).toEqual(["gendered_address"]);
    expect(codes(fem, "feminine")).toEqual([]);
    expect(gate3({ ...base, reply: fem, ownerAddress: "feminine" }).ok).toBe(true);
    expect(codes(masc, "feminine")).toEqual(["gendered_address"]);
    expect(codes(masc, "masculine")).toEqual([]);
    expect(codes(fem, "masculine")).toEqual(["gendered_address"]);
    // Both forms in one reply: the other one is there, so it is still a fault.
    expect(codes("תרצי לראות? ואם תרצה, אפשר גם במידה אחרת.", "feminine")).toEqual(["gendered_address"]);
    // A slash form is never the owner's form.
    expect(codes("בשמחה. תרצה/י שנעבור יחד על האפשרויות?", "feminine")).toContain("slash_form");
    // The rule is about Hebrew: an English reply is read as before.
    expect(gate3({ ...base, locale: "en", reply: "Sure. Shall we go over the options together?", ownerAddress: "feminine" }).ok).toBe(true);
  });
  it("★ gate3: \"צודקת\" and \"מעדיפה\" follow the same rule, each against its other gender", () => {
    expect(codes("את צודקת. אפשר לעבור יחד על האפשרויות.")).toContain("gendered_agree");
    expect(codes("את צודקת. אפשר לעבור יחד על האפשרויות.", "feminine")).toEqual([]);
    expect(codes("אתה צודק. אפשר לעבור יחד על האפשרויות.", "feminine")).toContain("gendered_agree");
    expect(codes("אתה צודק. אפשר לעבור יחד על האפשרויות.", "masculine")).toEqual([]);
    expect(codes("מעדיפה לעבור יחד על האפשרויות?")).toEqual(expect.arrayContaining(["gendered_address", "gendered_prefers"]));
    expect(codes("מעדיפה לעבור יחד על האפשרויות?", "feminine")).toEqual([]);
    expect(codes("מעדיף לעבור יחד על האפשרויות?", "feminine")).toEqual(expect.arrayContaining(["gendered_address", "gendered_prefers"]));
    expect(codes("מעדיף לעבור יחד על האפשרויות?", "masculine")).toEqual([]);
  });
  it("★ the correction names the owner's form; with no address rule it asks for the neutral address, as today", () => {
    const style = (...c: string[]) => [{ kind: "style" as const, codes: c }];
    const fem = correctionNote(style("gendered_address"), "he", { rules: true, handover: 0, address: "feminine" });
    expect(fem).toContain("- The business's rule sets the feminine form of address: address the customer in the feminine form only (את, תרצי, תוכלי), never the masculine form and no slash forms.");
    expect(fem).not.toContain("Address the customer neutrally");
    const masc = correctionNote(style("gendered_address"), "he", { rules: true, handover: 0, address: "masculine" });
    expect(masc).toContain("in the masculine form only (אתה, תרצה, תוכל), never the feminine form");
    for (const owner of [undefined, { rules: true, handover: 0 }, { rules: true, handover: 0, address: null }]) {
      const none = correctionNote(style("gendered_address", "gendered_agree", "gendered_prefers"), "he", owner);
      expect(none).toContain("- Address the customer neutrally (לך / אפשר + infinitive), no gendered verbs and no slash forms.");
      expect(none).toContain('- "נכון" or "בדיוק", not "צודק/צודקת" (the customer\'s gender is not known).');
      expect(none).toContain('- No "שים לב" or "מעדיף/ה": rephrase neutrally.');
      expect(none).not.toContain("form of address");
    }
    const words = correctionNote(style("gendered_agree", "gendered_prefers"), "he", { rules: true, handover: 0, address: "feminine" });
    expect(words).toContain('- "צודקת" or "נכון", not "צודק": the business\'s rule sets the feminine form of address.');
    expect(words).toContain('- "מעדיפה", not "מעדיף": the business\'s rule sets the feminine form of address.');
    expect(words).not.toContain("מעדיף/ה");
    expect(words).not.toContain("gender is not known");
    // English replies have no gendered address: the rule changes nothing there.
    expect(correctionNote(style("gendered_address"), "en", { rules: true, handover: 0, address: "feminine" })).toContain("- Address the customer neutrally.");
  });
  it("★ the printout and the audit carry the gender", () => {
    expect(cutLine({ ownerAddress: "feminine" })).toBe(" | ownerAddress=feminine");
    expect(cutFields({ ownerAddress: "masculine" })).toEqual({ ownerAddress: "masculine" });
    expect(cutLine({})).toBe("");
    expect(cutFields({ ownerAddress: null })).toBeUndefined();
  });
});

describe("an infinitive or a noun is no order to the customer (prod replay of 18aedcf2: \"אפשר לכתוב איזה מוצר\" was read as \"write!\" to a man)", () => {
  const ctx = { locale: "he" as const, isFirstReply: false, incomingMessage: "", productFactsAvailable: true, shopFloor: true, toolsOffered: [], customerClosing: false };
  const gendered = (t: string) => checkReplyStyle(t, ctx).filter((v) => v.kind === "gendered_address").length > 0;
  it.each([
    "אם מדובר במייקאפ אחר, אפשר לכתוב איזה מוצר, ואכוון לפי הגוון שלו.",
    "לפי הכתוב באתר, המשלוח חינם.",
    "ראינו שכתוב שם אחרת.",
    "ההזמנה מוכנה לאיסוף בתוך כחצי שעה, ולפעמים מחכים לחצי שעה נוספת.",
    "לחץ המים בברז משפיע על הזרימה.",
    "אפשר לשלוח לי כאן את מספר ההזמנה.",
    "אפשר לתת לי כמה פרטים ונמשיך.",
  ])("%s is not flagged", (t) => { expect(gendered(t)).toBe(false); });
  it.each([
    "כתוב לי את מספר ההזמנה.",
    "וכתוב לי את מספר ההזמנה.",
    "כתבי לי את מספר ההזמנה.",
    "לחץ על הקישור כדי לשלם.",
    "לחצי כאן כדי לשלם.",
    "ולחצי על הקישור.",
    "תן לי רגע לבדוק.",
    "תני לי את מספר ההזמנה.",
    "שלח לי תמונה של המוצר.",
    "שלחי לי תמונה של המוצר.",
    "בחרי צבע ונמשיך.",
  ])("%s is still flagged", (t) => { expect(gendered(t)).toBe(true); });
  it("★ the plural rewrite leaves half an hour alone and still turns the order", () => {
    expect(neutralSecondPerson("ההזמנה תגיע עד לחצי שעה. תרצי לחכות?")).toBe("ההזמנה תגיע עד לחצי שעה. תרצו לחכות?");
    expect(neutralSecondPerson("לחצי על הקישור כדי לשלם.")).toBe("לחצו על הקישור כדי לשלם.");
    expect(neutralSecondPerson("ולחצי כאן.")).toBe("ולחצו כאן.");
  });
});
