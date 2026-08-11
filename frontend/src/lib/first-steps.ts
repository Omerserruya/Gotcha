// First-steps ordering. Lives outside app/getting-started/page.tsx because a
// Next App Router page module may export only the route's own contract
// (default + metadata/config); any extra export fails the typed-routes build.
import type { JourneyMilestone } from "@/lib/api";

/**
 * The one step to do next: whatever needs attention first, else the step the
 * journey marks active, else something already under way, else the first step
 * still open. Returns null once everything is done, which is what tells the
 * page to show its finished state instead of an "up next" card.
 *
 * Order is the server's - this never re-sorts the journey, only picks from it.
 */
export function nextAction(milestones: JourneyMilestone[]): JourneyMilestone | null {
  const open = milestones.filter((m) => !m.done);
  if (open.length === 0) return null;
  return (
    open.find((m) => m.state === "attention") ??
    open.find((m) => m.status === "active") ??
    open.find((m) => m.state === "in_progress") ??
    open[0]
  );
}
