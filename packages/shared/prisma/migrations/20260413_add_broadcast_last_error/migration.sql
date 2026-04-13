-- Capture channel-level errors on the broadcast when we halt it mid-flight.
ALTER TABLE "broadcasts" ADD COLUMN "last_error" TEXT;
