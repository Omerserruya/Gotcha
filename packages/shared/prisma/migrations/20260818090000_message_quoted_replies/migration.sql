-- Quoted replies.
--
-- Every channel we run lets a customer reply to ONE specific earlier message,
-- and until now we dropped that entirely. The agent saw "yes, that one works"
-- against a list of four dates with no way to tell which it answered, and
-- neither did the AI - which is how a bot confirms the wrong one.
--
-- Two columns because the two ids answer different questions and arrive at
-- different times. The provider's id is what the payload carries and is always
-- present; ours is a resolution that can legitimately miss, because a customer
-- can quote a message from before GOTCHA was connected or one since deleted.
-- Keeping the external id when the lookup misses is what lets the UI say
-- "replying to an earlier message" instead of silently showing nothing.

ALTER TABLE "messages" ADD COLUMN "reply_to_external_id" TEXT;
ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" TEXT;

-- SetNull rather than Cascade: deleting a quoted message must not delete the
-- reply to it, which is somebody's actual answer and the more valuable of the two.
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey"
    FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Resolving an inbound quote is a lookup by the provider's id scoped to the
-- conversation. Without this it is a scan of every message the tenant has, on
-- the inbound hot path.
CREATE INDEX "messages_conversation_id_reply_to_external_id_idx"
    ON "messages"("conversation_id", "reply_to_external_id");
CREATE INDEX "messages_reply_to_message_id_idx" ON "messages"("reply_to_message_id");
