-- Customer notes: the local record, mirrored to the elected system.
--
-- Hand-assembled from `prisma migrate diff`, taking ONLY the customer_notes
-- statements. The full diff against the dev database emits 82 statements,
-- because the schema and the applied migrations have drifted apart over time
-- (missing foreign keys, renamed indexes across dozens of unrelated tables).
-- Applying that drift here would be a sweeping change nobody asked for, on a
-- database another team shares. This migration adds one table and its three
-- enums and touches nothing else.

-- CreateEnum
CREATE TYPE "CustomerNoteVisibility" AS ENUM ('TEAM', 'PRIVATE');
CREATE TYPE "CustomerNoteStatus" AS ENUM ('PUBLISHED', 'AI_SUGGESTED', 'REJECTED');
CREATE TYPE "CustomerNoteSyncStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "person_id" TEXT,
    "conversation_id" TEXT,
    "body" TEXT NOT NULL,
    "visibility" "CustomerNoteVisibility" NOT NULL DEFAULT 'TEAM',
    "status" "CustomerNoteStatus" NOT NULL DEFAULT 'PUBLISHED',
    "author_user_id" TEXT,
    "author_name" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "edit_history" JSONB NOT NULL DEFAULT '[]',
    "external_system" TEXT,
    "external_note_id" TEXT,
    "external_sync_status" "CustomerNoteSyncStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "external_sync_error" TEXT,
    "external_synced_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_notes_tenant_id_contact_id_created_at_idx" ON "customer_notes"("tenant_id", "contact_id", "created_at");
CREATE INDEX "customer_notes_tenant_id_person_id_idx" ON "customer_notes"("tenant_id", "person_id");
CREATE INDEX "customer_notes_tenant_id_status_idx" ON "customer_notes"("tenant_id", "status");
CREATE INDEX "customer_notes_tenant_id_external_sync_status_idx" ON "customer_notes"("tenant_id", "external_sync_status");

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
