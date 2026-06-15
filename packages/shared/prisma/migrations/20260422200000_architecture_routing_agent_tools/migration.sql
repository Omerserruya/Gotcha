-- Architecture convergence, phase 1:
--   1. RouterRule: priority → position (list-ordered, first-match-wins)
--   2. Tenant: routing fallback ladder + auto-resume config
--   3. AIAgent: capabilities, behavioralAnchors, escalationGates (mode + guidance + deterministic gates)
--   4. CatalogTool: hitlPolicy, allowedModes, whenToUse, exampleUsage, runtime limits, schemaVersion
--
-- All changes are forward-compatible except for the RouterRule.priority drop,
-- which is safe because the only readers (routing.service.ts + router-rules.ts
-- route) are updated in the same PR to use `position`.

-- ─── 1. RouterRule: priority → position ──────────────────────

ALTER TABLE "router_rules"
  ADD COLUMN "position" integer NOT NULL DEFAULT 0;

-- Preserve the current ordering: position copies priority verbatim
UPDATE "router_rules" SET "position" = "priority";

-- Swap the composite index to point at `position`
DROP INDEX IF EXISTS "router_rules_tenant_id_enabled_priority_idx";
CREATE INDEX "router_rules_tenant_id_enabled_position_idx"
  ON "router_rules" ("tenant_id", "enabled", "position");

-- Drop the old column. Safe because:
--   - routing.service.ts rewritten to use `position`
--   - router-rules.ts GET uses orderBy position
--   - MainPlaybookEditor saves to `position` in this PR
ALTER TABLE "router_rules" DROP COLUMN "priority";

-- ─── 2. Tenant: routing fallback ladder ──────────────────────

ALTER TABLE "tenants"
  ADD COLUMN "default_agent_id"                     text,
  ADD COLUMN "default_routine_id"                   text,
  ADD COLUMN "default_department_id"                text,
  ADD COLUMN "auto_resume_after_unclaim_minutes"    integer;

-- ─── 3. AIAgent: mode capabilities + anchors + gates ─────────

ALTER TABLE "ai_agents"
  ADD COLUMN "capabilities"        jsonb NOT NULL DEFAULT '{"auto":true,"assist":true}',
  ADD COLUMN "behavioral_anchors"  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN "escalation_gates"    jsonb NOT NULL DEFAULT '[]';

-- Backfill escalation_gates from the deterministic half of escalation_rules.
-- escalation_rules today mixes "max_messages" (deterministic) with
-- "customer angry" (LLM-judged). Split the deterministic ones into gates;
-- leave escalation_rules in place for now (LLM-judged half still rendered
-- in the prompt by prompt-assembler). Each row gets a single-element array
-- - no aggregation needed, since max_autonomous_messages is row-scoped.
UPDATE "ai_agents"
SET "escalation_gates" = jsonb_build_array(
  jsonb_build_object(
    'type',    'max_messages',
    'value',   "max_autonomous_messages",
    'enabled', true
  )
);

-- ─── 4. CatalogTool: HITL + contract + limits ────────────────

ALTER TABLE "catalog_tools"
  ADD COLUMN "when_to_use"                text,
  ADD COLUMN "example_usage"              jsonb,
  ADD COLUMN "allowed_modes"              jsonb   NOT NULL DEFAULT '["AUTO","ASSIST"]',
  ADD COLUMN "hitl_policy"                jsonb   NOT NULL DEFAULT '{"mode":"never"}',
  ADD COLUMN "timeout_ms"                 integer NOT NULL DEFAULT 10000,
  ADD COLUMN "max_retries"                integer NOT NULL DEFAULT 0,
  ADD COLUMN "retry_backoff_ms"           integer NOT NULL DEFAULT 1000,
  ADD COLUMN "circuit_breaker_threshold"  integer,
  ADD COLUMN "schema_version"             integer NOT NULL DEFAULT 1;

-- Seed hitl_policy for known-risky tools. Replaces the hardcoded
-- INTERNAL_HIGH_RISK_DEFAULTS set in packages/shared/src/lib/tool-gate.ts.
-- Tools matched by slug (integration-owned writes + destructive ops).
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"always"}'::jsonb
 WHERE "slug" IN (
   'process_refund', 'issue_refund',
   'cancel_order',
   'create_deal', 'update_deal',
   'create_lead'
 );

-- High-risk tools default to AUTO-only (human must explicitly propose in assist).
-- Leaves READ-category tools available in both modes.
UPDATE "catalog_tools"
SET "allowed_modes" = '["AUTO"]'::jsonb
WHERE "risk_level" = 'HIGH';
