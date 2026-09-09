-- Shopify grandfathering: the standing grant, separate from the decision log.
--
-- HAND-WRITTEN, for the same reason as 20260831120000: schema.prisma already
-- differs from its own migration history on main by ~214 lines, including
-- DROP TABLE for three config tables. A generated migration would sweep that
-- pre-existing drift in. That drift is a real question and it is not this
-- change's question.
--
-- WHY A TABLE AND NOT A COLUMN ON billing_policy_decisions
-- --------------------------------------------------------
-- That table is an append-only log of what the resolver concluded each time it
-- ran, and what it concludes depends on the flags in force at that moment.
-- Eligibility is a fact about the PAST - when a workspace first paid - and must
-- not change because somebody toggled a flag between two installs. So the
-- standing fact gets its own row, with UNIQUE(tenant_id) making the grant
-- idempotent across any number of reinstalls.
--
-- Everything here is ADDITIVE. No column dropped, no constraint altered, no
-- existing row rewritten.

-- ─── Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "ShopifyGrandfatherSource" AS ENUM ('AUTOMATIC', 'ADMIN_OVERRIDE');
CREATE TYPE "ShopifyGrandfatherStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- ─── Table ────────────────────────────────────────────────────────────────
CREATE TABLE "shopify_grandfather_grants" (
    "id"                  TEXT NOT NULL,
    "tenant_id"           TEXT NOT NULL,
    "status"              "ShopifyGrandfatherStatus" NOT NULL DEFAULT 'ACTIVE',
    "source"              "ShopifyGrandfatherSource" NOT NULL,
    "reason"              TEXT NOT NULL,
    -- The date the workspace started PAYING. Never the account creation date:
    -- an account opened in January that first paid in November is a new
    -- customer commercially, and November is what the cutoff is measured
    -- against.
    "paid_since"          TIMESTAMP(3),
    -- Which row produced paid_since: 'invoice_paid_at',
    -- 'subscription_activated_event' or 'subscription_created_at'. The three
    -- are not equally strong and a reviewer must be able to tell which one
    -- carried the decision.
    "paid_since_evidence" TEXT,
    -- The cutoff in force when this was decided. Stored, not re-read: the
    -- configured cutoff can move, and a grant must stay explainable against the
    -- rule that actually produced it.
    "cutoff_at"           TIMESTAMP(3),
    "evidence"            JSONB NOT NULL DEFAULT '{}',
    "evidence_quality"    "PolicyEvidenceQuality" NOT NULL DEFAULT 'UNKNOWN',
    -- The internal admin who accepted responsibility for an override. Never a
    -- tenant user.
    "approved_by"         TEXT,
    "granted_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"          TIMESTAMP(3),
    "revoked_by"          TEXT,
    "revoked_reason"      TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_grandfather_grants_pkey" PRIMARY KEY ("id")
);

-- One grant per workspace, forever. This constraint IS the idempotence: two
-- concurrent installs cannot produce two grants, and a reinstall finds the
-- existing row rather than re-deciding eligibility.
CREATE UNIQUE INDEX "shopify_grandfather_grants_tenant_id_key"
    ON "shopify_grandfather_grants"("tenant_id");

CREATE INDEX "shopify_grandfather_grants_status_idx"
    ON "shopify_grandfather_grants"("status");

-- Answers "who was grandfathered by rule vs by decision" with a WHERE clause
-- rather than by reading a JSON blob.
CREATE INDEX "shopify_grandfather_grants_source_idx"
    ON "shopify_grandfather_grants"("source");

-- ─── Reversal ─────────────────────────────────────────────────────────────
-- Prisma has no down migrations, so this is the script to run by hand. It is
-- complete: nothing above touches an existing table, so dropping these restores
-- the previous state exactly.
--
--   DROP TABLE IF EXISTS "shopify_grandfather_grants";
--   DROP TYPE IF EXISTS "ShopifyGrandfatherStatus";
--   DROP TYPE IF EXISTS "ShopifyGrandfatherSource";
