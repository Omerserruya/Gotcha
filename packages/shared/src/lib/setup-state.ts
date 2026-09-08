/**
 * The day-one setup state machine.
 *
 * `/api/onboarding/setup-map` returns tiles of `{ id, done, deepLink, stage }`.
 * A boolean is not this: the screen orders steps by what UNBLOCKS GOTCHA, and
 * that needs four states, not two. "Available but not yet" and "cannot start
 * until something else finishes" look identical through a `done` flag, and they
 * are the difference between a step the owner can do now and one that will
 * waste their time.
 *
 * `next` is decided HERE, on the server. Two surfaces computing "what should I
 * do now" from the same booleans will disagree the moment either changes, and
 * the one an owner is looking at is the one that is wrong.
 *
 * NO TITLES OR DESCRIPTIONS. They are translated copy and belong in the
 * frontend, keyed on `id`. Sending English prose would repeat the mistake the
 * insights endpoint just had to be dug out of.
 */

export type SetupStepState = "done" | "next" | "waiting" | "blocked";

export interface SetupStepDefinition {
  id: string;
  /** Steps that must be `done` before this one can be started. */
  requires: string[];
  /** Honest order-of-magnitude, for the screen to set expectations. */
  estimateMinutes: number;
  /** Whether Go live is sealed until this is done. */
  gatesGoLive: boolean;
}

/**
 * Ordered by what unblocks GOTCHA, not by effort.
 *
 * Connecting a channel comes first because without one there is nothing to
 * answer; knowledge comes before handover rules because a bot with rules and
 * nothing to say is worse than one with neither.
 */
export const SETUP_STEPS: SetupStepDefinition[] = [
  { id: "connect_channel",   requires: [],                    estimateMinutes: 5,  gatesGoLive: true },
  { id: "connect_store",     requires: [],                    estimateMinutes: 5,  gatesGoLive: false },
  { id: "add_knowledge",     requires: [],                    estimateMinutes: 10, gatesGoLive: true },
  { id: "hire_employee",     requires: ["add_knowledge"],     estimateMinutes: 10, gatesGoLive: true },
  { id: "handover_rules",    requires: ["hire_employee"],     estimateMinutes: 5,  gatesGoLive: true },
  { id: "approval_limits",   requires: ["hire_employee"],     estimateMinutes: 3,  gatesGoLive: true },
  { id: "test_conversation", requires: ["connect_channel", "hire_employee"], estimateMinutes: 3, gatesGoLive: true },
  { id: "invite_team",       requires: [],                    estimateMinutes: 2,  gatesGoLive: false },
];

export interface SetupStep {
  id: string;
  state: SetupStepState;
  completedAt: string | null;
  /** Step ids that hold this one back. Empty unless `state` is "blocked". */
  blockedBy: string[];
  estimateMinutes: number;
}

export interface SetupState {
  steps: SetupStep[];
  isLive: boolean;
  goLive: { eligible: boolean; blockedBy: string[] };
  trial: { daysRemaining: number | null; conversationsUsed: number } | null;
}

/** What the caller has to find out; this module owns only the reasoning. */
export interface SetupFacts {
  completed: Record<string, Date | null | undefined>;
  isLive: boolean;
  trial: { daysRemaining: number | null; conversationsUsed: number } | null;
}

/**
 * Turn the facts into the machine.
 *
 * Exactly one step is ever `next`: the first startable one that is not done.
 * A screen showing two "do this now" steps is showing neither.
 */
export function computeSetupState(facts: SetupFacts): SetupState {
  const isDone = (id: string) => facts.completed[id] != null;

  const steps: SetupStep[] = [];
  let nextTaken = false;

  for (const def of SETUP_STEPS) {
    const completedAt = facts.completed[def.id] ?? null;
    if (completedAt) {
      steps.push({
        id: def.id,
        state: "done",
        completedAt: completedAt.toISOString(),
        blockedBy: [],
        estimateMinutes: def.estimateMinutes,
      });
      continue;
    }

    const blockedBy = def.requires.filter((r) => !isDone(r));
    let state: SetupStepState;
    if (blockedBy.length > 0) {
      state = "blocked";
    } else if (!nextTaken) {
      state = "next";
      nextTaken = true;
    } else {
      state = "waiting";
    }

    steps.push({ id: def.id, state, completedAt: null, blockedBy, estimateMinutes: def.estimateMinutes });
  }

  // What Go live is waiting on. Reported even when already live, so a screen
  // can explain a workspace that was taken back out of live mode.
  const goLiveBlockers = SETUP_STEPS.filter((d) => d.gatesGoLive && !isDone(d.id)).map((d) => d.id);

  return {
    steps,
    isLive: facts.isLive,
    goLive: { eligible: goLiveBlockers.length === 0, blockedBy: goLiveBlockers },
    trial: facts.trial,
  };
}
