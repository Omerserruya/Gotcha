-- Historical Intelligence Import.
--
-- Importing a business's existing conversation history (first source: the
-- WhatsApp Business app via Meta Coexistence chat-history sync), normalizing
-- it, learning from it, and turning what it reveals into knowledge the owner
-- reviews before it becomes production knowledge.
--
-- Every column added to an EXISTING table is nullable or defaulted, so no
-- existing row changes meaning and no existing writer has to be touched.
-- See docs/architecture/historical-intelligence-import.md.

-- ─── Enums ───────────────────────────────────────────────────

-- LIVE vs imported. Explicit rather than inferred from a timestamp: an import
-- writes rows dated months ago and a late webhook writes a row dated
-- yesterday, so the two are indistinguishable by date. Treating a historical
-- message as live would have the AI answer a customer about an order from March.
CREATE TYPE "RecordOrigin" AS ENUM ('LIVE', 'HISTORICAL_IMPORT');

CREATE TYPE "HistoricalImportSource" AS ENUM ('WHATSAPP_BUSINESS_APP');

CREATE TYPE "HistoricalImportStatus" AS ENUM (
    'NOT_AVAILABLE',
    'PENDING',
    'SOURCE_SYNCING',
    'SOURCE_COMPLETE',
    'INGESTING',
    'IDENTITY_RESOLUTION',
    'CUSTOMER_LEARNING',
    'KNOWLEDGE_EXTRACTION',
    'KNOWLEDGE_CLUSTERING',
    'ANALYTICS',
    'REVIEW_READY',
    'COMPLETED',
    'FAILED'
);

CREATE TYPE "KnowledgeCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- ─── historical_imports ──────────────────────────────────────

CREATE TABLE "historical_imports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source" "HistoricalImportSource" NOT NULL,
    "channel_account_id" TEXT,
    "status" "HistoricalImportStatus" NOT NULL DEFAULT 'PENDING',

    "source_progress" INTEGER NOT NULL DEFAULT 0,
    "source_phase" INTEGER,
    "chunks_received" INTEGER NOT NULL DEFAULT 0,
    "customers_total" INTEGER NOT NULL DEFAULT 0,
    "customers_analyzed" INTEGER NOT NULL DEFAULT 0,

    "imported_messages" INTEGER NOT NULL DEFAULT 0,
    "duplicate_messages" INTEGER NOT NULL DEFAULT 0,
    "imported_customers" INTEGER NOT NULL DEFAULT 0,
    "matched_existing_customers" INTEGER NOT NULL DEFAULT 0,
    "matched_source_of_truth" INTEGER NOT NULL DEFAULT 0,
    "knowledge_candidate_count" INTEGER NOT NULL DEFAULT 0,
    "knowledge_conflict_count" INTEGER NOT NULL DEFAULT 0,
    "top_topics" JSONB,
    "summary" JSONB,

    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_completed_at" TIMESTAMP(3),
    "intelligence_started_at" TIMESTAMP(3),
    "review_ready_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "source_deadline_at" TIMESTAMP(3),
    "completion_email_sent_at" TIMESTAMP(3),

    "failure_reason" TEXT,
    "failed_stage" TEXT,
    "source_metadata" JSONB,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historical_imports_tenant_id_idx" ON "historical_imports"("tenant_id");
CREATE INDEX "historical_imports_tenant_id_status_idx" ON "historical_imports"("tenant_id", "status");
CREATE INDEX "historical_imports_channel_account_id_idx" ON "historical_imports"("channel_account_id");
-- The watchdog's query: imports still in flight whose 24-hour Meta window closed.
CREATE INDEX "historical_imports_status_source_deadline_at_idx" ON "historical_imports"("status", "source_deadline_at");

ALTER TABLE "historical_imports" ADD CONSTRAINT "historical_imports_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "historical_imports" ADD CONSTRAINT "historical_imports_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── historical_import_chunks ────────────────────────────────
-- Raw chunks exactly as delivered. This table is what makes the feature safe
-- to retry, and it lets a parser fix be replayed against history we already
-- hold rather than needing a re-import Meta will not grant.

CREATE TABLE "historical_import_chunks" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "chunk_order" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "thread_count" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "historical_import_chunks_pkey" PRIMARY KEY ("id")
);

-- The idempotency anchor. Meta redelivers on any non-2xx and BullMQ retries on
-- throw; a redelivered chunk collides here and is dropped instead of
-- duplicating a conversation.
CREATE UNIQUE INDEX "historical_import_chunks_import_id_phase_chunk_order_key"
    ON "historical_import_chunks"("import_id", "phase", "chunk_order");
CREATE INDEX "historical_import_chunks_import_id_processed_at_idx"
    ON "historical_import_chunks"("import_id", "processed_at");
CREATE INDEX "historical_import_chunks_tenant_id_idx" ON "historical_import_chunks"("tenant_id");

ALTER TABLE "historical_import_chunks" ADD CONSTRAINT "historical_import_chunks_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "historical_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── historical_import_events ────────────────────────────────

CREATE TABLE "historical_import_events" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "detail" JSONB,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_import_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historical_import_events_import_id_created_at_idx" ON "historical_import_events"("import_id", "created_at");
CREATE INDEX "historical_import_events_import_id_step_idx" ON "historical_import_events"("import_id", "step");

ALTER TABLE "historical_import_events" ADD CONSTRAINT "historical_import_events_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "historical_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── historical_customers ────────────────────────────────────
-- The unit of work for customer learning ("842 / 1,247") and the source of the
-- linkage statistics. NOT a second customer table: the durable identity stays
-- `contacts`, and this row points at it.

CREATE TABLE "historical_customers" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "normalized_phone" TEXT,
    "display_name" TEXT,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "source_of_truth_vendor" TEXT,
    "source_of_truth_customer_id" TEXT,
    "source_of_truth_matched_at" TIMESTAMP(3),
    "discovered_identities" JSONB,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "first_message_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "learning_status" TEXT NOT NULL DEFAULT 'PENDING',
    "learning_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_customers_pkey" PRIMARY KEY ("id")
);

-- One row per person per import. Re-running identity resolution updates rather
-- than duplicating.
CREATE UNIQUE INDEX "historical_customers_import_id_external_id_key"
    ON "historical_customers"("import_id", "external_id");
CREATE UNIQUE INDEX "historical_customers_conversation_id_key"
    ON "historical_customers"("conversation_id");
CREATE INDEX "historical_customers_tenant_id_idx" ON "historical_customers"("tenant_id");
CREATE INDEX "historical_customers_import_id_learning_status_idx"
    ON "historical_customers"("import_id", "learning_status");
CREATE INDEX "historical_customers_tenant_id_normalized_phone_idx"
    ON "historical_customers"("tenant_id", "normalized_phone");

ALTER TABLE "historical_customers" ADD CONSTRAINT "historical_customers_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "historical_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "historical_customers" ADD CONSTRAINT "historical_customers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "historical_customers" ADD CONSTRAINT "historical_customers_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── customer_historical_memory ──────────────────────────────
-- Durable understanding of one customer. Tenant-scoped, not agent-scoped: what
-- history teaches is a fact about the CUSTOMER, so every agent benefits.
-- The unique key is what makes a retry rebuild rather than append.

CREATE TABLE "customer_historical_memory" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_external_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "facts" JSONB NOT NULL,
    "summary" TEXT,
    "source" TEXT NOT NULL,
    "import_id" TEXT,
    "message_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_historical_memory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_historical_memory_tenant_id_customer_external_id_key"
    ON "customer_historical_memory"("tenant_id", "customer_external_id");
CREATE INDEX "customer_historical_memory_tenant_id_updated_at_idx"
    ON "customer_historical_memory"("tenant_id", "updated_at");
CREATE INDEX "customer_historical_memory_import_id_idx"
    ON "customer_historical_memory"("import_id");

ALTER TABLE "customer_historical_memory" ADD CONSTRAINT "customer_historical_memory_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_historical_memory" ADD CONSTRAINT "customer_historical_memory_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "historical_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── knowledge_candidates ────────────────────────────────────
-- Historical answers are EVIDENCE, NOT TRUTH. Nothing here reaches the
-- production knowledge base without the owner approving it.

CREATE TABLE "knowledge_candidates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "edited_answer" TEXT,
    "status" "KnowledgeCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occurrence_count" INTEGER NOT NULL DEFAULT 0,
    "customer_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "cluster_key" TEXT NOT NULL,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "variants" JSONB,
    "duplicate_of_document_id" TEXT,
    "approved_document_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_candidates_pkey" PRIMARY KEY ("id")
);

-- One candidate per cluster per import: re-running clustering updates counts on
-- the existing row instead of resurrecting a suggestion the owner rejected.
CREATE UNIQUE INDEX "knowledge_candidates_import_id_cluster_key_key"
    ON "knowledge_candidates"("import_id", "cluster_key");
CREATE INDEX "knowledge_candidates_tenant_id_status_idx" ON "knowledge_candidates"("tenant_id", "status");
CREATE INDEX "knowledge_candidates_import_id_status_idx" ON "knowledge_candidates"("import_id", "status");

ALTER TABLE "knowledge_candidates" ADD CONSTRAINT "knowledge_candidates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_candidates" ADD CONSTRAINT "knowledge_candidates_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "historical_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_candidates" ADD CONSTRAINT "knowledge_candidates_approved_document_id_fkey"
    FOREIGN KEY ("approved_document_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "knowledge_candidates" ADD CONSTRAINT "knowledge_candidates_duplicate_of_document_id_fkey"
    FOREIGN KEY ("duplicate_of_document_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── knowledge_candidate_evidence ────────────────────────────

CREATE TABLE "knowledge_candidate_evidence" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "variant_key" TEXT,
    "question_text" TEXT NOT NULL,
    "answer_text" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3),
    "representative" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_candidate_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_candidate_evidence_candidate_id_representative_idx"
    ON "knowledge_candidate_evidence"("candidate_id", "representative");
CREATE INDEX "knowledge_candidate_evidence_tenant_id_idx" ON "knowledge_candidate_evidence"("tenant_id");

ALTER TABLE "knowledge_candidate_evidence" ADD CONSTRAINT "knowledge_candidate_evidence_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "knowledge_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Existing tables: origin + provenance ────────────────────
-- Both defaulted to LIVE, so every existing row keeps its meaning and every
-- existing writer keeps working without being touched.

ALTER TABLE "conversations" ADD COLUMN "origin" "RecordOrigin" NOT NULL DEFAULT 'LIVE';
ALTER TABLE "conversations" ADD COLUMN "historical_import_id" TEXT;

ALTER TABLE "messages" ADD COLUMN "origin" "RecordOrigin" NOT NULL DEFAULT 'LIVE';
ALTER TABLE "messages" ADD COLUMN "historical_import_id" TEXT;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_historical_import_id_fkey"
    FOREIGN KEY ("historical_import_id") REFERENCES "historical_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_historical_import_id_fkey"
    FOREIGN KEY ("historical_import_id") REFERENCES "historical_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every inbox, routing and analytics query means LIVE rows. Without these the
-- lot would start scanning imported history the moment a tenant connects
-- Coexistence and six months of it lands in the same tables.
CREATE INDEX "conversations_tenant_id_origin_status_idx" ON "conversations"("tenant_id", "origin", "status");
CREATE INDEX "conversations_historical_import_id_idx" ON "conversations"("historical_import_id");
CREATE INDEX "messages_historical_import_id_idx" ON "messages"("historical_import_id");
CREATE INDEX "messages_tenant_id_origin_idx" ON "messages"("tenant_id", "origin");

-- ─── Partial unique indexes: import-only dedupe guarantees ───
--
-- PARTIAL on purpose. A plain unique index on messages(external_message_id)
-- would be a risky migration on a large live table with pre-existing duplicates
-- and nulls, and it would constrain rows this feature never touches. Scoping
-- the predicate to imported rows gives a hard database-level guarantee exactly
-- where retries happen and changes nothing else.

CREATE UNIQUE INDEX "messages_historical_external_id_key"
    ON "messages"("tenant_id", "external_message_id")
    WHERE "origin" = 'HISTORICAL_IMPORT' AND "external_message_id" IS NOT NULL;

-- V1 groups all of a customer's imported messages into ONE historical
-- conversation. This is what enforces that, so a replayed chunk cannot open a
-- second thread for the same person.
CREATE UNIQUE INDEX "conversations_historical_customer_key"
    ON "conversations"("historical_import_id", "customer_external_id")
    WHERE "historical_import_id" IS NOT NULL;

-- At most ONE import in flight per channel account.
--
-- History chunks arrive concurrently and the worker runs them in parallel, so
-- without this two chunks can each find no import and each create one, leaving
-- the customer's history split across two runs that both look half finished.
-- The predicate excludes finished imports on purpose: a business that
-- offboards and redoes Embedded Signup is legitimately entitled to a second
-- import, and blocking that would make the only supported re-import path
-- impossible.
CREATE UNIQUE INDEX "historical_imports_active_channel_key"
    ON "historical_imports"("channel_account_id")
    WHERE "channel_account_id" IS NOT NULL
      AND "status" NOT IN ('COMPLETED', 'FAILED', 'NOT_AVAILABLE');
