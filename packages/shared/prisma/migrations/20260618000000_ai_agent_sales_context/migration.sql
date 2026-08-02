-- Product Qualification Context for sales-oriented AI employees.
-- Static-per-agent JSON: { whatWeSell, idealCustomerProfile, problemsSolved[],
-- expectedOutcomes[], qualificationSignals[], disqualifiers[] }
ALTER TABLE "ai_agents" ADD COLUMN "sales_context" JSONB;
