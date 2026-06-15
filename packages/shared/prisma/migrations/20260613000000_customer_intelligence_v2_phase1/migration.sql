-- Customer Intelligence V2 - Phase 1 foundation.
-- See docs/customer-intelligence-domain-model.md.
--
-- ADDITIVE + idempotent: new enums, new tables, one nullable column on
-- business_profiles. Safe to run against a drifted dev DB (IF NOT EXISTS /
-- guarded DO blocks). No backfill required - all new columns are
-- nullable or defaulted.

-- ── Enums (idempotent via DO guards; CREATE TYPE has no IF NOT EXISTS) ──
DO $$ BEGIN
  CREATE TYPE "IntelligenceScope" AS ENUM ('CUSTOMER', 'OPPORTUNITY', 'CONVERSATION');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'ENUM', 'DATE', 'ENTITY_REF');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "FactSource" AS ENUM ('MANUAL', 'CRM_INBOUND', 'LLM_CLOSE', 'LLM_LIVE', 'RULE', 'DERIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'ABANDONED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "FieldOrigin" AS ENUM ('PACK', 'CUSTOM', 'DISCOVERED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── BusinessProfile.packSlug ──
ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "pack_slug" TEXT;

-- ── CustomerProfile ──
CREATE TABLE IF NOT EXISTS "customer_profiles" (
  "id"                 TEXT NOT NULL,
  "tenant_id"          TEXT NOT NULL,
  "identity_key"       TEXT NOT NULL,
  "person_id"          TEXT,
  "contact_id"         TEXT,
  "crm_contact_id"     TEXT,
  "crm_object_kind"    TEXT,
  "display_name"       TEXT,
  "phone"              TEXT,
  "email"              TEXT,
  "facts"              JSONB NOT NULL DEFAULT '{}',
  "behavioral_signals" JSONB NOT NULL DEFAULT '{}',
  "first_seen_at"      TIMESTAMP(3),
  "last_seen_at"       TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_profiles_tenant_id_identity_key_key" ON "customer_profiles"("tenant_id", "identity_key");
CREATE INDEX IF NOT EXISTS "customer_profiles_tenant_id_idx" ON "customer_profiles"("tenant_id");
CREATE INDEX IF NOT EXISTS "customer_profiles_tenant_id_crm_contact_id_idx" ON "customer_profiles"("tenant_id", "crm_contact_id");

-- ── Opportunity ──
CREATE TABLE IF NOT EXISTS "opportunities" (
  "id"                  TEXT NOT NULL,
  "tenant_id"           TEXT NOT NULL,
  "customer_profile_id" TEXT NOT NULL,
  "type"                TEXT NOT NULL,
  "pack_id"             TEXT,
  "title"               TEXT,
  "stage"               TEXT,
  "status"              "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
  "estimated_value"     DOUBLE PRECISION,
  "next_action"         TEXT,
  "facts"               JSONB NOT NULL DEFAULT '{}',
  "relationships"       JSONB NOT NULL DEFAULT '{}',
  "opened_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"           TIMESTAMP(3),
  "last_activity_at"    TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "opportunities_tenant_id_idx" ON "opportunities"("tenant_id");
CREATE INDEX IF NOT EXISTS "opportunities_tenant_id_customer_profile_id_idx" ON "opportunities"("tenant_id", "customer_profile_id");
CREATE INDEX IF NOT EXISTS "opportunities_tenant_id_status_idx" ON "opportunities"("tenant_id", "status");

DO $$ BEGIN
  ALTER TABLE "opportunities"
    ADD CONSTRAINT "opportunities_customer_profile_id_fkey"
    FOREIGN KEY ("customer_profile_id") REFERENCES "customer_profiles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── IntelligencePack ──
CREATE TABLE IF NOT EXISTS "intelligence_packs" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT,
  "slug"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "version"       INTEGER NOT NULL DEFAULT 1,
  "fields"        JSONB NOT NULL DEFAULT '[]',
  "default_rules" JSONB NOT NULL DEFAULT '{}',
  "is_system"     BOOLEAN NOT NULL DEFAULT false,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intelligence_packs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "intelligence_packs_tenant_id_slug_key" ON "intelligence_packs"("tenant_id", "slug");
CREATE INDEX IF NOT EXISTS "intelligence_packs_is_system_idx" ON "intelligence_packs"("is_system");

-- ── FieldDefinition ──
CREATE TABLE IF NOT EXISTS "field_definitions" (
  "id"              TEXT NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "key"             TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  "description"     TEXT,
  "type"            "FieldType" NOT NULL DEFAULT 'TEXT',
  "scope"           "IntelligenceScope" NOT NULL DEFAULT 'OPPORTUNITY',
  "options"         JSONB NOT NULL DEFAULT '[]',
  "required"        BOOLEAN NOT NULL DEFAULT false,
  "stage_relevance" JSONB NOT NULL DEFAULT '[]',
  "ai_extract"      BOOLEAN NOT NULL DEFAULT true,
  "sync_to_crm"     BOOLEAN NOT NULL DEFAULT true,
  "crm_field_map"   JSONB,
  "origin"          "FieldOrigin" NOT NULL DEFAULT 'CUSTOM',
  "pack_slug"       TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "field_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "field_definitions_tenant_id_key_key" ON "field_definitions"("tenant_id", "key");
CREATE INDEX IF NOT EXISTS "field_definitions_tenant_id_idx" ON "field_definitions"("tenant_id");
CREATE INDEX IF NOT EXISTS "field_definitions_tenant_id_scope_idx" ON "field_definitions"("tenant_id", "scope");

-- ── IntelligenceFact (append-only) ──
CREATE TABLE IF NOT EXISTS "intelligence_facts" (
  "id"               TEXT NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "entity_type"      "IntelligenceScope" NOT NULL,
  "entity_id"        TEXT NOT NULL,
  "field_key"        TEXT NOT NULL,
  "value"            JSONB NOT NULL,
  "confidence"       DOUBLE PRECISION NOT NULL DEFAULT 1,
  "source"           "FactSource" NOT NULL,
  "observed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "conversation_id"  TEXT,
  "valid_until"      TIMESTAMP(3),
  "superseded_by_id" TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_facts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "intelligence_facts_tenant_id_idx" ON "intelligence_facts"("tenant_id");
CREATE INDEX IF NOT EXISTS "intelligence_facts_tenant_id_entity_type_entity_id_idx" ON "intelligence_facts"("tenant_id", "entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "intelligence_facts_tenant_id_entity_type_entity_id_field_key_idx" ON "intelligence_facts"("tenant_id", "entity_type", "entity_id", "field_key");
