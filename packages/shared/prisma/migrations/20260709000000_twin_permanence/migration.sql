-- Twin permanence (P0/P1): resume checkpoint, live ceremony phase, tune transcript.
ALTER TABLE "business_discoveries" ADD COLUMN "progress" TEXT;
ALTER TABLE "business_discoveries" ADD COLUMN "scan_phase" TEXT;
ALTER TABLE "business_discoveries" ADD COLUMN "tune_transcript" JSONB;
