/**
 * Which of the queue menu's actions apply, and to which conversations.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AN ITEM IS SHOWN ONLY IF PRESSING IT CAN DO SOMETHING
 * ════════════════════════════════════════════════════════════════════════════
 * The rule this project has kept throughout: a control that does nothing is
 * worse than its absence. So each action lists the targets it would actually
 * act on, by the ROUTE's own rules, and the menu draws an item only when that
 * list is not empty. With several conversations selected, an action applies
 * to those it can, and the menu says how many.
 *
 *   Assign to me          /claim      any conversation not already yours
 *   Assign to someone ›   /reassign   an ADMIN, or the person holding it —
 *                                     the route 403s anyone else
 *   Put back in the queue /release    held by somebody; by them or an ADMIN
 *   Mark resolved         /close      anything not already CLOSED
 *   Delete                DELETE      ADMIN and SYSTEM_ADMIN only — the route
 *                                     403s everyone else
 *
 * Not here, and on purpose (Omer's rule, until Backend makes them live):
 * Pause the AI here (no backend), Mark as unread and Archive (routes written,
 * not deployed, and nothing reads `archivedAt`).
 */

export interface MenuRow {
  readonly id: string;
  readonly status: string;
  readonly assignedAgentId: string | null;
}

export interface MenuViewer {
  readonly meId: string | null;
  readonly role: string | null;
  /** Is there anyone to assign to? The list never includes the viewer. */
  readonly hasColleagues: boolean;
}

export interface MenuPlan {
  readonly assignToMe: readonly string[];
  readonly assignToSomeone: readonly string[];
  readonly release: readonly string[];
  readonly resolve: readonly string[];
  readonly remove: readonly string[];
}

const ADMIN_ROLES = new Set(['ADMIN', 'SYSTEM_ADMIN']);

/**
 * ⚠ AN UNREAD ROLE IS NOT ADMIN. The safe default for "may this delete" is
 *   no: the route refuses anyone else, and a Delete that 403s is a control
 *   that does nothing.
 */
export const isAdmin = (role: string | null): boolean => role !== null && ADMIN_ROLES.has(role);

export function menuPlan(targets: readonly MenuRow[], viewer: MenuViewer): MenuPlan {
  const admin = isAdmin(viewer.role);
  const mine = (row: MenuRow) => viewer.meId !== null && row.assignedAgentId === viewer.meId;
  const ids = (keep: (row: MenuRow) => boolean) => targets.filter(keep).map((row) => row.id);

  return {
    assignToMe: viewer.meId === null ? [] : ids((row) => !mine(row)),
    assignToSomeone: viewer.hasColleagues ? ids((row) => admin || mine(row)) : [],
    release: ids((row) => row.assignedAgentId !== null && (admin || mine(row))),
    resolve: ids((row) => row.status !== 'CLOSED'),
    remove: admin ? ids(() => true) : [],
  };
}
