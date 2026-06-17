/**
 * Industry Intelligence Packs (Customer Intelligence V2 - system, shared).
 *
 * Single source of truth for the system packs. Imported by the main seed
 * (`seed.ts`) AND runnable standalone via `seed-packs.ts`, so packs can be
 * (re)seeded WITHOUT running the full database seed (which has other ordering
 * dependencies). `seedIntelligencePacks` is idempotent: existing system packs
 * are updated in place, new ones created.
 *
 * Each `fields` entry is a scope-tagged template cloned into per-tenant
 * FieldDefinition rows when a tenant applies the pack. scope/type are lowercase
 * here and normalized to the Prisma enums by the apply route.
 * See docs/customer-intelligence-domain-model.md §4.4.
 */

export type PackField = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "enum" | "date";
  scope: "customer" | "opportunity" | "conversation";
  options?: string[];
  required?: boolean;
};

export const SYSTEM_PACKS: { slug: string; name: string; fields: PackField[] }[] = [
  {
    slug: "event_hall",
    name: "Event Hall",
    fields: [
      { key: "event_type", label: "Event Type", type: "enum", scope: "opportunity", options: ["wedding", "bar_mitzvah", "bat_mitzvah", "brit", "corporate", "other"] },
      { key: "event_date", label: "Event Date", type: "text", scope: "opportunity" },
      { key: "event_time", label: "Event Time", type: "text", scope: "opportunity" },
      { key: "guest_count", label: "Guest Count", type: "number", scope: "opportunity", required: true },
      { key: "budget", label: "Budget", type: "number", scope: "opportunity" },
      { key: "kosher_level", label: "Kosher Level", type: "enum", scope: "opportunity", options: ["regular", "mehadrin", "badatz"] },
      { key: "outdoor_ceremony", label: "Outdoor Ceremony", type: "boolean", scope: "opportunity" },
      { key: "parking_required", label: "Parking Required", type: "boolean", scope: "opportunity" },
      { key: "special_requests", label: "Special Requests", type: "text", scope: "opportunity" },
      { key: "bride_name", label: "Bride Name", type: "text", scope: "opportunity" },
      { key: "groom_name", label: "Groom Name", type: "text", scope: "opportunity" },
    ],
  },
  {
    slug: "real_estate",
    name: "Real Estate",
    fields: [
      { key: "property_type", label: "Property Type", type: "enum", scope: "opportunity", options: ["apartment", "house", "penthouse", "commercial", "land"] },
      { key: "rooms", label: "Rooms", type: "number", scope: "opportunity" },
      { key: "budget", label: "Budget", type: "number", scope: "opportunity" },
      { key: "location", label: "Location", type: "text", scope: "opportunity" },
      { key: "move_date", label: "Move Date", type: "text", scope: "opportunity" },
      { key: "mortgage_required", label: "Mortgage Required", type: "boolean", scope: "opportunity" },
    ],
  },
  {
    slug: "recruiting",
    name: "Recruiting",
    fields: [
      { key: "desired_position", label: "Desired Position", type: "text", scope: "opportunity" },
      { key: "expected_salary", label: "Expected Salary", type: "number", scope: "opportunity" },
      { key: "availability", label: "Availability", type: "text", scope: "opportunity" },
      { key: "experience_years", label: "Years of Experience", type: "number", scope: "customer" },
      { key: "security_clearance", label: "Security Clearance", type: "boolean", scope: "customer" },
    ],
  },
  {
    slug: "ecommerce",
    name: "E-commerce",
    fields: [
      { key: "order_number", label: "Order Number", type: "text", scope: "opportunity" },
      { key: "order_status", label: "Order Status", type: "enum", scope: "opportunity", options: ["pending", "shipped", "delivered", "returned", "cancelled"] },
      { key: "product", label: "Product", type: "text", scope: "opportunity" },
      { key: "refund_requested", label: "Refund Requested", type: "boolean", scope: "opportunity" },
      { key: "shipping_issue", label: "Shipping Issue", type: "boolean", scope: "opportunity" },
      { key: "delivery_date", label: "Delivery Date", type: "text", scope: "opportunity" },
    ],
  },
  {
    slug: "healthcare",
    name: "Healthcare / Clinics",
    fields: [
      { key: "treatment_interest", label: "Treatment Interest", type: "text", scope: "opportunity" },
      { key: "appointment_type", label: "Appointment Type", type: "enum", scope: "opportunity", options: ["consultation", "follow_up", "procedure", "routine_checkup", "emergency"] },
      { key: "urgency", label: "Urgency", type: "enum", scope: "conversation", options: ["routine", "soon", "urgent"] },
      { key: "appointment_booked", label: "Appointment Booked", type: "boolean", scope: "opportunity" },
      { key: "preferred_clinic", label: "Preferred Clinic / Location", type: "text", scope: "opportunity" },
      { key: "insurance_provider", label: "Insurance Provider", type: "text", scope: "customer" },
      { key: "patient_status", label: "Patient Status", type: "enum", scope: "customer", options: ["new_patient", "existing_patient", "inquiry"] },
      { key: "referral_source", label: "Referral Source", type: "text", scope: "customer" },
    ],
  },
  {
    slug: "education",
    name: "Education / Courses",
    fields: [
      { key: "program_interest", label: "Program of Interest", type: "text", scope: "opportunity" },
      { key: "start_term", label: "Desired Start Term", type: "text", scope: "opportunity" },
      { key: "delivery_mode", label: "Delivery Mode", type: "enum", scope: "opportunity", options: ["online", "in_person", "hybrid"] },
      { key: "budget", label: "Budget", type: "number", scope: "opportunity" },
      { key: "scholarship_needed", label: "Scholarship Needed", type: "boolean", scope: "opportunity" },
      { key: "enrollment_stage", label: "Enrollment Stage", type: "enum", scope: "opportunity", options: ["inquiry", "applied", "accepted", "enrolled"] },
      { key: "study_level", label: "Study Level", type: "enum", scope: "customer", options: ["high_school", "undergraduate", "graduate", "professional", "other"] },
      { key: "field_of_study", label: "Field of Study", type: "text", scope: "customer" },
    ],
  },
  {
    slug: "saas",
    name: "SaaS",
    fields: [
      { key: "use_case", label: "Use Case", type: "text", scope: "opportunity" },
      { key: "plan_interest", label: "Plan of Interest", type: "enum", scope: "opportunity", options: ["free", "starter", "pro", "enterprise"] },
      { key: "budget", label: "Budget", type: "number", scope: "opportunity" },
      { key: "timeline", label: "Timeline", type: "text", scope: "opportunity" },
      { key: "decision_maker", label: "Is Decision Maker", type: "boolean", scope: "opportunity" },
      { key: "trial_status", label: "Trial Status", type: "enum", scope: "opportunity", options: ["none", "active", "expired", "converted"] },
      { key: "integration_needs", label: "Integration Needs", type: "text", scope: "opportunity" },
      { key: "current_tool", label: "Current / Competing Tool", type: "text", scope: "customer" },
      { key: "team_size", label: "Team Size", type: "number", scope: "customer" },
      { key: "company_size", label: "Company Size", type: "enum", scope: "customer", options: ["solo", "smb", "mid_market", "enterprise"] },
    ],
  },
  {
    slug: "professional_services",
    name: "Professional Services",
    fields: [
      { key: "service_needed", label: "Service Needed", type: "text", scope: "opportunity" },
      { key: "project_scope", label: "Project Scope", type: "text", scope: "opportunity" },
      { key: "engagement_type", label: "Engagement Type", type: "enum", scope: "opportunity", options: ["one_time", "project", "retainer", "hourly"] },
      { key: "budget", label: "Budget", type: "number", scope: "opportunity" },
      { key: "timeline", label: "Timeline", type: "text", scope: "opportunity" },
      { key: "decision_maker", label: "Is Decision Maker", type: "boolean", scope: "opportunity" },
      { key: "industry", label: "Industry", type: "text", scope: "customer" },
      { key: "company_size", label: "Company Size", type: "enum", scope: "customer", options: ["solo", "smb", "mid_market", "enterprise"] },
    ],
  },
];

/** Idempotently upsert all system packs. `prisma` is any PrismaClient. */
export async function seedIntelligencePacks(prisma: any): Promise<void> {
  for (const pack of SYSTEM_PACKS) {
    // tenantId is null for system packs; the (tenantId, slug) unique index
    // treats NULLs as distinct, so use findFirst + update/create for idempotency.
    const existing = await prisma.intelligencePack.findFirst({
      where: { tenantId: null, slug: pack.slug },
    });
    if (existing) {
      await prisma.intelligencePack.update({
        where: { id: existing.id },
        data: { name: pack.name, fields: pack.fields as any, isSystem: true },
      });
    } else {
      await prisma.intelligencePack.create({
        data: { tenantId: null, slug: pack.slug, name: pack.name, fields: pack.fields as any, isSystem: true },
      });
    }
  }
  console.log(`Industry packs: ${SYSTEM_PACKS.map((p) => p.slug).join(", ")}`);
}
