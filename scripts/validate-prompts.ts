/**
 * Prompt validation harness - renders 30 assembled prompts across a matrix of
 * (situation × brand archetype) and asserts the de-confliction + humanization
 * invariants hold on the ACTUAL assembled prompt (not just the source files).
 *
 * Run in the ai container:  npx tsx /tmp/validate-prompts.ts
 */
import { prisma } from "@chatcenter/shared";
import { buildAgentPrompt } from "/app/services/ai/src/services/prompt-builder.service";
import { computeBehaviorState } from "/app/services/ai/src/services/behavior-engine.service";

const AGENT_ID = "cmnvsm2ao0003eioazm6qbg8c";
const ARCHETYPES = ["trusted_advisor", "high_energy_coach", "luxury_concierge", "beauty_consultant", "neutral"];

// 6 conversation situations → drive different strategies / stages / depths / languages.
const SITUATIONS = [
  { key: "initial_he",     locale: "he", lastMessage: "היי",                                   messageCount: 1,  id: { hasContact: false, contactLifecycle: null,      priorConversationCount: 0 } },
  { key: "explore_he",     locale: "he", lastMessage: "אנחנו מאבדים הרבה לידים בוואטסאפ",       messageCount: 4,  id: { hasContact: true,  contactLifecycle: "lead",    priorConversationCount: 0 } },
  { key: "buying_he",      locale: "he", lastMessage: "כמה זה עולה? אני רוצה להתחיל",            messageCount: 6,  id: { hasContact: true,  contactLifecycle: "lead",    priorConversationCount: 1 } },
  { key: "objection_en",   locale: "en", lastMessage: "honestly this is too expensive for us", messageCount: 8,  id: { hasContact: true,  contactLifecycle: "lead",    priorConversationCount: 1 } },
  { key: "support_he",     locale: "he", lastMessage: "יש לי בעיה, לא מצליח לשלוח הודעות",       messageCount: 3,  id: { hasContact: true,  contactLifecycle: "customer", priorConversationCount: 5 } },
  { key: "returning_en",   locale: "en", lastMessage: "hey, back again - need help with billing", messageCount: 5, id: { hasContact: true, contactLifecycle: "customer", priorConversationCount: 8 } },
];

const REDACTED_CUSTOMER = [
  "## Customer & Conversation Info",
  "- Customer Name: <<REDACTED>>",
  "- External ID / Phone: <<REDACTED>>",
  "- Channel: WHATSAPP",
].join("\n");

function assertions(p: string, locale: string, archetype: string) {
  const has = (s: string) => p.includes(s);
  const archLabel: Record<string, string> = {
    trusted_advisor: "Trusted Advisor", high_energy_coach: "High-Energy Coach",
    luxury_concierge: "Luxury Concierge", beauty_consultant: "Beauty Consultant", neutral: "Neutral / Professional",
  };
  return {
    "no_closer_reallow":      !has("is allowed AFTER you have advanced"),
    "no_convert_forced_close": !has("soft close go together") && !has("soft availability close") ,
    "no_office_ladder":       !has("Information-Gathering Ladder") && !has("לקבוע מועד לסיור") && !has("היסטוריה של משרד"),
    "hierarchy_present":      has("SINGLE SOURCE OF TRUTH") && has("Style tie-break"),
    "brand_voice_present":    has(`# Brand Voice - ${archLabel[archetype]}`),
    "acknowledge_before_ask": has("Acknowledge before you ask"),
    "personality_present":    has("# Personality"),
    "gender_rule_general":    has("Gendered languages - infer"),
    "gender_hebrew_when_he":  locale !== "he" || has("Gender in Hebrew"),
  };
}

function dupCounts(p: string) {
  const count = (re: RegExp) => (p.match(re) || []).length;
  return {
    fabricate:        count(/fabricat/gi),
    availability_closer: count(/if you need anything else|אם יש שאלות נוספות אני כאן/gi),
    one_question:     count(/one question|ONE question|שאלה אחת/gi),
    crm_before_ask:   count(/before asking|before you ask|run CRM lookups/gi),
  };
}

async function main() {
  console.log("[harness] building 30 prompts…");
  const config = await prisma.aIAgent.findUnique({ where: { id: AGENT_ID } });
  if (!config) throw new Error("agent not found");

  const rows: any[] = [];
  for (const arch of ARCHETYPES) {
    for (const s of SITUATIONS) {
      const behaviorState = computeBehaviorState({
        mode: "agent",
        identity: s.id as any,
        request: { lastMessage: s.lastMessage, messageCount: s.messageCount, recentDirections: ["INBOUND"] },
      });
      const agent: any = {
        name: config.name, role: config.role, tone: config.tone, style: config.style,
        identity: config.identity, goals: config.goals, toneConfig: config.toneConfig,
        behavioral: (config as any).behavioral,
        persona: { ...((config.persona as any) || {}), brand_archetype: arch },
        conversationFlow: config.conversationFlow, customGuardrails: config.customGuardrails,
        escalationRules: config.escalationRules, behavioralAnchors: (config as any).behavioralAnchors,
      };
      const p = buildAgentPrompt({ behaviorState, agent, context: { customerBlock: REDACTED_CUSTOMER, locale: s.locale }, knowledge: { block: undefined } });
      rows.push({
        archetype: arch, situation: s.key, locale: s.locale,
        strategy: behaviorState.strategy, stage: behaviorState.conversationStage,
        relationship: behaviorState.relationshipStrength.level,
        chars: p.length, tokens: Math.round(p.length / 4),
        checks: assertions(p, s.locale, arch), dups: dupCounts(p),
      });
    }
  }

  // ---- aggregate ----
  const total = rows.length;
  const checkNames = Object.keys(rows[0].checks);
  const failBy: Record<string, number> = {};
  for (const c of checkNames) failBy[c] = rows.filter((r) => !r.checks[c]).length;
  const totalFails = rows.filter((r) => Object.values(r.checks).some((v) => !v)).length;

  const sizes = rows.map((r) => r.tokens);
  const strat: Record<string, number> = {};
  for (const r of rows) strat[r.strategy] = (strat[r.strategy] || 0) + 1;

  console.log("\n==================  PROMPT VALIDATION REPORT  ==================");
  console.log(`Prompts generated: ${total}  (${ARCHETYPES.length} archetypes × ${SITUATIONS.length} situations)`);
  console.log(`Prompts with ANY failed check: ${totalFails}/${total}`);
  console.log(`\nStrategy coverage: ${JSON.stringify(strat)}`);
  console.log(`Relationship depths seen: ${JSON.stringify([...new Set(rows.map(r => r.relationship))])}`);
  console.log(`Languages: ${JSON.stringify([...new Set(rows.map(r => r.locale))])}`);
  console.log(`\nSize (tokens): min=${Math.min(...sizes)}  avg=${Math.round(sizes.reduce((a,b)=>a+b,0)/total)}  max=${Math.max(...sizes)}`);

  console.log(`\nPer-check failures (0 = all ${total} prompts pass):`);
  for (const c of checkNames) console.log(`  ${failBy[c] === 0 ? "✅" : "❌"} ${c}: ${total - failBy[c]}/${total} pass`);

  // residual duplication (informational - not failures)
  const dupAgg: Record<string, number[]> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.dups)) (dupAgg[k] ||= []).push(v as number);
  console.log(`\nResidual duplicate-phrase counts (avg occurrences per prompt - dedup candidates):`);
  for (const [k, arr] of Object.entries(dupAgg)) console.log(`  ${k}: avg ${(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1)}×`);

  if (totalFails > 0) {
    console.log(`\nFAILING ROWS:`);
    for (const r of rows.filter((r) => Object.values(r.checks).some((v) => !v)))
      console.log(`  ${r.archetype}/${r.situation} [${r.strategy}/${r.stage}] → ${Object.entries(r.checks).filter(([,v])=>!v).map(([k])=>k).join(", ")}`);
  }
  console.log("================================================================\n");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => { console.error("HARNESS ERROR:", e.stack || e.message); await prisma.$disconnect(); process.exit(1); });
