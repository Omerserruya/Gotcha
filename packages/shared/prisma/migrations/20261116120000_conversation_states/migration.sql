-- Reply engine v2: one state row per conversation per lane (live | shadow).
-- Additive only: a new table, two indexes, one FK that cascades with the conversation.
-- CreateTable
CREATE TABLE "conversation_states" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "lane" TEXT NOT NULL DEFAULT 'live',
    "ai_agent_id" TEXT,
    "stage" TEXT,
    "intent" TEXT,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "offered_items" JSONB NOT NULL DEFAULT '[]',
    "pending" JSONB NOT NULL DEFAULT '[]',
    "active_skill" TEXT,
    "summary" TEXT,
    "summary_up_to" TIMESTAMP(3),
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_states_tenant_id_updated_at_idx" ON "conversation_states"("tenant_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_states_conversation_id_lane_key" ON "conversation_states"("conversation_id", "lane");

-- AddForeignKey
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

