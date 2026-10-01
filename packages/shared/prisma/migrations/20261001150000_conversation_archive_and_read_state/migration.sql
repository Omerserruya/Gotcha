-- Right-click actions the queue screen promises but the server could not do.
--
-- The design specifies seven context-menu actions. Five already had routes.
-- "Archive" had nothing at all, and "mark as unread" existed only as a
-- localStorage set in the old frontend (`chatcenter:markedUnread`) - so it was
-- lost on another device, lost when site data was cleared, and invisible to
-- the rest of the team. Our own privacy page documented it as browser storage.
--
-- ARCHIVE IS A COLUMN, NOT A STATUS. A conversation can be CLOSED and archived,
-- or archived while still WAITING. Adding ARCHIVED to the status enum would
-- make those mutually exclusive and would quietly change every count that
-- groups by status - archiving a closed conversation would drop it out of the
-- closed figure.
ALTER TABLE "conversations" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "conversations_tenant_id_archived_at_idx"
  ON "conversations" ("tenant_id", "archived_at");

-- READ STATE BELONGS TO THE PERSON, NOT THE THREAD.
--
-- "I marked this unread" is a fact about one agent. A column on conversations
-- would mean one agent marking unread marks it unread for everybody, which is
-- neither what the old product did nor what anyone expects.
CREATE TABLE "conversation_read_states" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "marked_unread" BOOLEAN NOT NULL DEFAULT false,
    "last_read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_read_states_user_id_conversation_id_key"
  ON "conversation_read_states" ("user_id", "conversation_id");

CREATE INDEX "conversation_read_states_tenant_id_user_id_marked_unread_idx"
  ON "conversation_read_states" ("tenant_id", "user_id", "marked_unread");

CREATE INDEX "conversation_read_states_conversation_id_idx"
  ON "conversation_read_states" ("conversation_id");

ALTER TABLE "conversation_read_states"
  ADD CONSTRAINT "conversation_read_states_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_read_states"
  ADD CONSTRAINT "conversation_read_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_read_states"
  ADD CONSTRAINT "conversation_read_states_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
