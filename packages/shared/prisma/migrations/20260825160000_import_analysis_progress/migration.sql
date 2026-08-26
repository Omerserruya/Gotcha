-- Analysis progress needs a measured denominator, not an estimate.
-- Customer learning already stored its two numbers; extraction had none, so the
-- progress bar could only be shown for the transfer half of an import.
ALTER TABLE "historical_imports"
  ADD COLUMN IF NOT EXISTS "conversations_eligible" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "conversations_extracted" INTEGER NOT NULL DEFAULT 0;
