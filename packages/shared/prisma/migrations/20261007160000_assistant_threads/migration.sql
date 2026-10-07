-- Home chat threads (docs/api/assistant-threads-v1.md). Additive: two new
-- tables, nothing existing changes. Hand-written (the generated diff carries
-- unrelated drift; see docs/operations/dev-environment-hazards.md).

CREATE TABLE "assistant_threads" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "title_source" TEXT,
    "scope" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "assistant_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "scope" JSONB,
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "run_id" TEXT,
    "usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_threads_tenant_id_user_id_updated_at_idx" ON "assistant_threads"("tenant_id", "user_id", "updated_at" DESC);

CREATE INDEX "assistant_messages_thread_id_created_at_idx" ON "assistant_messages"("thread_id", "created_at");

ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
