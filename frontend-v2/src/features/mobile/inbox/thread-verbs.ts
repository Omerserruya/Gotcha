/**
 * What the phone's thread bar offers about the AI (Omer, 2026-11-03).
 *
 * ★★ NO SWITCH, AND NO STATE WORD. "AI פעיל" / "AI מושהה" read as a status
 *   and pressed as a verb, and the reader could not tell which. Now:
 *
 *     handed to a person, an AI employee to hand back to, not resolved
 *                 → one button, "החזר ל‑AI" (`returnToAi`, which also
 *                   unassigns the person, so it leaves "mine")
 *     the AI is on it
 *                 → nothing in the bar; "השהה את ה‑AI" (`stopAi`) is in ⋮,
 *                   so the verb is not lost
 *     resolved, or no AI employee
 *                 → nothing about the AI at all
 */
export interface ThreadAiControl {
  /** The bar's one button: hand it back to the AI. */
  readonly returnToAi: boolean;
  /** "Pause the AI" in the ⋮ menu. */
  readonly pauseInMenu: boolean;
}

export function threadAiControl(state: {
  readonly resolved: boolean;
  readonly handedOver: boolean;
  readonly hasAiEmployee: boolean;
}): ThreadAiControl {
  const live = !state.resolved && state.hasAiEmployee;
  return {
    returnToAi: live && state.handedOver,
    pauseInMenu: live && !state.handedOver,
  };
}
