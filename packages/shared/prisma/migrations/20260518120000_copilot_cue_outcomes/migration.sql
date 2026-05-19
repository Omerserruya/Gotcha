-- CreateTable
CREATE TABLE "copilot_cue_outcomes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "cue_id" TEXT NOT NULL,
    "cue_kind" TEXT NOT NULL,
    "cue_text" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_cue_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_cue_outcomes_cue_kind_cue_text_idx" ON "copilot_cue_outcomes"("cue_kind", "cue_text");

-- CreateIndex
CREATE INDEX "copilot_cue_outcomes_tenant_id_conversation_id_idx" ON "copilot_cue_outcomes"("tenant_id", "conversation_id");
