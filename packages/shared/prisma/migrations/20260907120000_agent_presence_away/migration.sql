-- Agent presence gains a deliberate AWAY state.
--
-- Purely ADDITIVE. The new enum value is not written by this migration and the
-- new column is nullable, so every existing agent_presences row keeps exactly
-- the status and behaviour it has today.
--
-- AWAY is not OFFLINE. OFFLINE is what we INFER when heartbeats stop; AWAY is
-- what an agent SAYS, and it comes with a time they expect to be back. Routing
-- and the team panel can act on the difference - "back at 11:00" is a fact
-- somebody stated, "offline" is our guess about a closed laptop.

-- AlterEnum
ALTER TYPE "PresenceStatus" ADD VALUE 'AWAY';

-- AlterTable
-- Nullable, and nothing sweeps it. Reads treat an elapsed window as ONLINE, so
-- an agent who never came back is not stranded AWAY by a job that failed to run.
ALTER TABLE "agent_presences" ADD COLUMN "away_until" TIMESTAMP(3);
