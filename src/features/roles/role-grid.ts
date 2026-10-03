import type { PermissionDef } from '@/api/contracts/permission-catalog';

/**
 * 12c's table, from the catalogue — the mapping Omer's supervisor approved.
 *
 * One row per `feature:sub-feature`. Where the actions really are a ladder,
 * the row is a LEVEL (None · View · Edit · Manage, each level holding the
 * ones below it). Where they are separate jobs — reply is not a lower
 * "assign", refund does not come bundled with return — the row is its
 * ACTIONS, toggled one by one. A feature the catalogue adds later and this
 * table does not know is a row of actions, never a guessed ladder.
 */

export const LEVELS = ['none', 'view', 'edit', 'manage'] as const;
export type Level = (typeof LEVELS)[number];

/** Each level's actions, cumulative. A missing level is not offered. */
type Ladder = Partial<Record<Exclude<Level, 'none'>, readonly string[]>>;

export const LADDERS: Readonly<Record<string, Ladder>> = {
  'crm:contacts': { view: ['read'], edit: ['read', 'update'] },
  'crm:deals': { view: ['read'], edit: ['read', 'update'] },
  'settings:workspace': { view: ['read'], edit: ['read', 'update'] },
  'channels:manage': { view: ['read'], edit: ['read', 'update'] },
  'ai:knowledge': { view: ['read'], edit: ['read', 'write'] },
  'settings:business-policies': { view: ['read'], manage: ['read', 'preview', 'manage'] },
  'ai:employees': {
    view: ['read'],
    edit: ['read', 'update'],
    manage: ['read', 'update', 'create', 'delete'],
  },
  'ai:workflows': {
    view: ['read'],
    edit: ['read', 'update'],
    manage: ['read', 'update', 'publish'],
  },
  'ai:tools': { view: ['read'], edit: ['read', 'assign'], manage: ['read', 'assign', 'manage'] },
  'integrations:connections': {
    view: ['read'],
    edit: ['read', 'connect'],
    manage: ['read', 'connect', 'disconnect'],
  },
  'business-systems:connections': {
    view: ['read'],
    edit: ['read', 'connect'],
    manage: ['read', 'connect', 'manage'],
  },
  'settings:members': { manage: ['manage'] },
  'settings:roles': { manage: ['manage'] },
  'approvals:policies': { manage: ['manage'] },
};

export interface GridRow {
  /** `feature:sub-feature`. */
  readonly id: string;
  readonly domain: string;
  readonly permissions: readonly PermissionDef[];
  /** Any permission here takes the role assignment's scope. */
  readonly scoped: boolean;
  readonly ladder: Ladder | null;
}

/** The catalogue as 12c's rows, in the catalogue's order. */
export function gridRows(permissions: readonly PermissionDef[]): readonly GridRow[] {
  const rows = new Map<string, PermissionDef[]>();
  for (const p of permissions) {
    const id = `${p.feature}:${p.subFeature}`;
    const list = rows.get(id);
    if (list) list.push(p);
    else rows.set(id, [p]);
  }
  return [...rows.entries()].map(([id, list]) => {
    const ladder = LADDERS[id] ?? null;
    const actions = new Set(list.map((p) => p.action));
    // A ladder whose actions the catalogue no longer has is not a ladder.
    const fits =
      ladder !== null &&
      Object.values(ladder).every((acts) => acts!.every((a) => actions.has(a))) &&
      [...actions].every((a) => Object.values(ladder).some((acts) => acts!.includes(a)));
    return {
      id,
      domain: list[0]!.domain,
      permissions: list,
      scoped: list.some((p) => p.scoped),
      ladder: fits ? ladder : null,
    };
  });
}

const keyOf = (row: GridRow, action: string) => `${row.id}:${action}`;

/** The levels a row offers: None, then the ones its ladder defines. */
export function levelsOf(row: GridRow): readonly Level[] {
  if (!row.ladder) return [];
  return LEVELS.filter((l) => l === 'none' || row.ladder![l as Exclude<Level, 'none'>]);
}

/**
 * The row's level for a selection — or `null` when the selection holds a mix
 * no level describes (an edit without its read, say). A null is drawn as no
 * segment chosen, never rounded to a level.
 */
export function levelOf(row: GridRow, selected: ReadonlySet<string>): Level | null {
  if (!row.ladder) return null;
  const held = row.permissions.filter((p) => selected.has(p.key)).map((p) => p.action);
  if (held.length === 0) return 'none';
  for (const level of levelsOf(row)) {
    if (level === 'none') continue;
    const acts = row.ladder[level as Exclude<Level, 'none'>]!;
    if (acts.length === held.length && acts.every((a) => held.includes(a))) return level;
  }
  return null;
}

/** The selection with this row set to a level. Other rows are untouched. */
export function withLevel(
  row: GridRow,
  level: Level,
  selected: readonly string[],
): readonly string[] {
  const mine = new Set(row.permissions.map((p) => p.key));
  const rest = selected.filter((k) => !mine.has(k));
  if (level === 'none' || !row.ladder) return rest;
  return [...rest, ...row.ladder[level as Exclude<Level, 'none'>]!.map((a) => keyOf(row, a))];
}

/** Does this row differ between two selections? 02's "● Changed from X". */
export function rowChanged(row: GridRow, a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return row.permissions.some((p) => a.has(p.key) !== b.has(p.key));
}
