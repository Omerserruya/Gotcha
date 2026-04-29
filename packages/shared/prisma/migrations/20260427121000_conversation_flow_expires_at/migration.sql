-- Comment→DM bridge expiry. Set when a comment-trigger flow promotes itself
-- into a paused conversation (private-reply DM sent, waiting on the user's
-- reply). If unmatched within 24h, Meta blocks further DMs in that thread,
-- so we close the conversation and drop chatbot state on expiry.
ALTER TABLE "conversations" ADD COLUMN "flow_expires_at" TIMESTAMP(3);

-- Indexed for the future sweep job that closes expired bridges proactively.
CREATE INDEX "conversations_flow_expires_at_idx" ON "conversations"("flow_expires_at");
