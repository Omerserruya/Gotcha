/**
 * Generator - produces a structured AIAgent configuration for a department
 * from the tenant's BusinessProfile + Department settings.
 *
 * This module owns the *normalization* layer: it maps free-form business
 * data into enumerated identity / goals / tone / behavioral / persona
 * structures the platform understands. The runtime prompt is assembled
 * later by `prompt-builder.service.ts` using these fields directly - no
 * pre-baked `systemPrompt` is stored.
 */

import { prisma } from "@chatcenter/shared";
import { getDefaultModel } from "./ai.service";

interface PersonaTraits {
  warmth?: string;
  humor?: string;
  [key: string]: string | undefined;
}

interface PersonaData {
  gender?: "male" | "female" | "neutral";
  traits?: PersonaTraits;
  customAttributes?: Record<string, string>;
}

interface BusinessProfileData {
  organizationName: string;
  industry: string;
  businessDescription: string;
  businessPriority: string;
}

interface DepartmentData {
  id: string;
  name: string;
  slaTarget: number | null;
  autoGreetingEnabled: boolean;
  autoRepliesEnabled: boolean;
  aiSuggestionsEnabled: boolean;
  escalateOnSlaBreach: boolean;
  autoCloseMinutes: number | null;
}

function generateIdentityBlock(profile: BusinessProfileData, dept: DepartmentData) {
  const roleMap: Record<string, string> = {
    "Sales": "Sales Representative",
    "Customer Support": "Customer Support Agent",
    "Technical Support": "Technical Support Specialist",
    "Operations": "Operations Coordinator",
  };

  const responsibilityMap: Record<string, string> = {
    "Sales": "Handle inbound sales inquiries, qualify leads, present solutions, and drive conversions",
    "Customer Support": "Resolve customer issues, answer questions, and ensure customer satisfaction",
    "Technical Support": "Diagnose technical problems, provide step-by-step solutions, and escalate complex issues",
    "Operations": "Coordinate operational requests, manage internal workflows, and facilitate cross-department communication",
  };

  return {
    role: roleMap[dept.name] || `${dept.name} Agent`,
    responsibility: responsibilityMap[dept.name] || `Handle all ${dept.name.toLowerCase()} related inquiries and tasks`,
    representationGuidelines: [
      `Represent ${profile.organizationName} professionally`,
      `Operate within the ${dept.name} department scope`,
      `Maintain awareness of ${profile.industry} industry standards`,
      `Align communication with the organization's brand identity`,
    ],
  };
}

function generateGoalsBlock(profile: BusinessProfileData, dept: DepartmentData) {
  const priorityGoals: Record<string, string[]> = {
    MAXIMIZE_SALES: [
      "Identify and capitalize on sales opportunities in every interaction",
      "Guide conversations toward product/service recommendations",
      "Track and improve conversion metrics",
    ],
    FAST_RESPONSE: [
      "Minimize response time on every interaction",
      "Provide quick, accurate answers without unnecessary back-and-forth",
      "Prioritize resolution speed while maintaining quality",
    ],
    PREMIUM_EXPERIENCE: [
      "Deliver personalized, high-touch customer experiences",
      "Anticipate customer needs and proactively offer solutions",
      "Build long-term customer relationships through exceptional service",
    ],
    REDUCE_WORKLOAD: [
      "Automate repetitive tasks and responses where possible",
      "Efficiently categorize and route inquiries",
      "Provide comprehensive self-service information to reduce follow-ups",
    ],
  };

  const deptFocus: Record<string, string> = {
    "Sales": "sales_conversion",
    "Customer Support": "customer_satisfaction",
    "Technical Support": "issue_resolution",
    "Operations": "operational_efficiency",
  };

  return {
    focus: deptFocus[dept.name] || "general_assistance",
    slaAwareness: dept.slaTarget
      ? `Respond within ${dept.slaTarget} minutes SLA target`
      : "Respond as quickly as possible",
    conversionObjective: priorityGoals[profile.businessPriority]?.[0] || "Assist customers effectively",
    qualityExpectations: [
      "Provide accurate and helpful information",
      "Maintain professional communication standards",
      ...(priorityGoals[profile.businessPriority]?.slice(1) || []),
    ],
  };
}

function generateToneBlock(profile: BusinessProfileData, dept: DepartmentData) {
  const toneProfiles: Record<string, { formality: string; empathy: string; assertiveness: string }> = {
    "Sales": { formality: "professional_friendly", empathy: "moderate", assertiveness: "high" },
    "Customer Support": { formality: "warm_professional", empathy: "high", assertiveness: "moderate" },
    "Technical Support": { formality: "precise_professional", empathy: "moderate", assertiveness: "moderate" },
    "Operations": { formality: "business_formal", empathy: "low", assertiveness: "high" },
  };

  const priorityToneAdjust: Record<string, Partial<typeof toneProfiles["Sales"]>> = {
    PREMIUM_EXPERIENCE: { empathy: "very_high", formality: "warm_professional" },
    FAST_RESPONSE: { formality: "concise_professional" },
    MAXIMIZE_SALES: { assertiveness: "high" },
    REDUCE_WORKLOAD: { formality: "efficient_professional" },
  };

  const baseTone = toneProfiles[dept.name] || { formality: "professional", empathy: "moderate", assertiveness: "moderate" };
  const adjusted = { ...baseTone, ...(priorityToneAdjust[profile.businessPriority] || {}) };

  return {
    formalityLevel: adjusted.formality,
    empathyLevel: adjusted.empathy,
    assertiveness: adjusted.assertiveness,
    brandAlignment: `Align tone with ${profile.organizationName}'s brand in the ${profile.industry} industry`,
  };
}

function generateBehavioralBlock(profile: BusinessProfileData, dept: DepartmentData) {
  const escalationTriggers = [
    "Customer explicitly requests to speak with a human",
    "Issue cannot be resolved with available information",
    "Customer expresses strong dissatisfaction or frustration",
    "Sensitive topics: billing disputes, account security, legal matters",
  ];

  if (dept.escalateOnSlaBreach && dept.slaTarget) {
    escalationTriggers.push(`SLA breach: conversation exceeds ${dept.slaTarget} minute response target`);
  }

  const noAutoReplyConditions = [
    "Ambiguous or unclear customer intent",
    "Complex multi-part questions requiring research",
    "Situations requiring human judgment or empathy",
    "When confidence in the response is below threshold",
  ];

  return {
    escalationTriggers,
    noAutoReplyConditions,
    forbiddenActions: [
      "Never share internal system information or technical details",
      "Never make promises about specific outcomes or timelines without authorization",
      "Never provide medical, legal, or financial advice",
      "Never share other customers' information",
      "Never bypass security or authentication procedures",
    ],
    safetyBoundaries: [
      "Do not engage with harmful, abusive, or illegal requests",
      "Protect customer privacy and data at all times",
      "Report suspicious activity patterns",
      "Maintain professional boundaries in all interactions",
    ],
    confidenceHandling: {
      highConfidence: "Respond directly with the information",
      mediumConfidence: "Provide answer with appropriate caveats",
      lowConfidence: "Flag for human review before sending",
    },
  };
}

/**
 * Generates a structured AI Employee config for a department.
 * Creates or updates an AIAgent record and links it to the department via a RouterRule.
 * If an existing AIAgent is provided via agentId, updates that agent instead.
 */
export async function generateAgentConfig(
  tenantId: string,
  departmentId: string,
  personaOverride?: PersonaData,
  agentId?: string,
): Promise<string> {
  const [profile, department] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { tenantId } }),
    prisma.department.findUnique({ where: { id: departmentId } }),
  ]);

  if (!profile || !department) {
    throw new Error("Business profile and department are required for agent config generation");
  }

  const profileData: BusinessProfileData = {
    organizationName: profile.organizationName,
    industry: profile.industry,
    businessDescription: profile.businessDescription,
    businessPriority: profile.businessPriority,
  };

  const deptData: DepartmentData = {
    id: department.id,
    name: department.name,
    slaTarget: department.slaTarget,
    autoGreetingEnabled: department.autoGreetingEnabled,
    autoRepliesEnabled: department.autoRepliesEnabled,
    aiSuggestionsEnabled: department.aiSuggestionsEnabled,
    escalateOnSlaBreach: department.escalateOnSlaBreach,
    autoCloseMinutes: department.autoCloseMinutes,
  };

  const config = {
    identity: generateIdentityBlock(profileData, deptData),
    goals: generateGoalsBlock(profileData, deptData),
    tone: generateToneBlock(profileData, deptData),
    behavioral: generateBehavioralBlock(profileData, deptData),
    persona: personaOverride,
  };

  // The runtime prompt is built from these structured fields by
  // `prompt-builder.service.ts` - no pre-baked systemPrompt is stored.
  const agentData = {
    identity: JSON.parse(JSON.stringify(config.identity)),
    goals: JSON.parse(JSON.stringify(config.goals)),
    toneConfig: JSON.parse(JSON.stringify(config.tone)),
    behavioral: JSON.parse(JSON.stringify(config.behavioral)),
    persona: personaOverride ? JSON.parse(JSON.stringify(personaOverride)) : undefined,
    status: "ACTIVE" as const,
    model: getDefaultModel(),
    provider: "openai",
    temperature: 0.7,
    maxTokens: 1024,
  };

  let agent;
  if (agentId) {
    agent = await prisma.aIAgent.update({
      where: { id: agentId },
      data: agentData,
    });
  } else {
    agent = await prisma.aIAgent.create({
      data: {
        tenantId,
        name: `${department.name} AI Employee`,
        role: "customer_support",
        // description column dropped per spec - identity is expressed via
        // structured fields (identity, persona, behavioralAnchors, etc).
        ...agentData,
      },
    });

    // Create router rule to link agent to department.
    const maxPos = await prisma.routerRule.aggregate({
      where: { tenantId },
      _max: { position: true as any } as any,
    });

    await prisma.routerRule.create({
      data: {
        tenantId,
        name: `${department.name} AI Employee`,
        position: (((maxPos as any)?._max?.position ?? 0) + 1) as any,
        conditions: [{ field: "department", operator: "equals", value: departmentId }],
        logic: "AND",
        routeType: "AI_AGENT",
        routeTarget: departmentId,
        aiAgentId: agent.id,
        enabled: true,
      } as any,
    });
  }

  return agent.id;
}

/**
 * Generates AI Employee configs for all departments of a tenant.
 */
export async function generateAllAgentConfigs(tenantId: string): Promise<void> {
  const departments = await prisma.department.findMany({
    where: { tenantId, isActive: true },
    select: { id: true },
  });

  await Promise.all(
    departments.map((dept) => generateAgentConfig(tenantId, dept.id)),
  );
}
