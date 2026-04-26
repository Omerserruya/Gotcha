-- Add per-conversation flow variable store.
-- Populated by flow nodes (Collect Input, Set Variable, HTTP Request, AI Generate,
-- Bring User Data). Interpolated into outbound Send* nodes via {{var_name}}.
ALTER TABLE "conversations" ADD COLUMN "flow_variables" JSONB;
