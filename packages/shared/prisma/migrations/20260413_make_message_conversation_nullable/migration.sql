-- Allow Message.conversation_id to be NULL for messages that aren't tied to
-- a Conversation (e.g. broadcast recipient sends, system notifications).
ALTER TABLE "messages" ALTER COLUMN "conversation_id" DROP NOT NULL;
