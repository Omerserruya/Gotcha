-- DropTable: token_logs was the orphan table duplicating usage_logs for AI
-- tracking. Nothing writes to it after the 20260414_enrich_usage_log_ai
-- migration + associated service refactor — all AI tracking now flows through
-- usage_logs (type='ai_tokens') with the denormalized feature/model/prompt/
-- completion/cost columns.
DROP TABLE IF EXISTS "token_logs";
