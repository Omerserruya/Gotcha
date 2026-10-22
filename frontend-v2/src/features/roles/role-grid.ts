import type { PermissionDef } from '@/api/contracts/permission-catalog';

/**
 * 12c's table, from the catalogue - the mapping Omer's supervisor approved.
 *
 * One row per `feature:sub-feature`. Where the actions really are a ladder,
 * the row is a LEVEL (None · View · Edit · Manage, each level holding the
 * ones below it). Where they are separate jobs - reply is not a lower
 * "assign", refund does not come bundled with return - the row is its
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
 * The row's level for a selection - or `null` when the selection holds a mix
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

/*
 * ════════════════════════════════════════════════════════════════════════════
 * A ROLE'S PATTERNS, ON THE GRID AND BACK (auth 30d610da: built-ins edit)
 * ════════════════════════════════════════════════════════════════════════════
 * Owner holds `*`; Department Manager holds `conversation:messages:*` beside
 * explicit keys. To edit one, the grid shows what each pattern covers today
 * (`expandPatterns`), and the save gives back every pattern whose keys are
 * all still on (`compactPatterns`) - so an untouched pattern stays a standing
 * instruction that picks up permissions added later, and only a pattern the
 * editor actually narrowed becomes a list.
 */

const isPattern = (f: string) => f === '*' || f.endsWith(':*');
const covers = (pattern: string, key: string) =>
  pattern === '*' || key.startsWith(pattern.slice(0, -1));

/** The keys a pattern covers in this catalogue; an exact key is itself. */
function keysOf(feature: string, catalog: readonly string[]): readonly string[] {
  return isPattern(feature) ? catalog.filter((key) => covers(feature, key)) : [feature];
}

/**
 * A role's keys with every pattern expanded against the catalogue. An exact
 * key the catalogue does not list is kept: dropping it would change the role
 * without anyone choosing to.
 */
export function expandPatterns(
  features: readonly string[],
  catalog: readonly string[],
): readonly string[] {
  return [...new Set(features.flatMap((f) => keysOf(f, catalog)))];
}

/**
 * The list to save: each pattern the role held, while every key it covers is
 * still on; everything else as keys. A pattern that covers nothing in this
 * catalogue is kept as it was - the grid could not show it, so it was not
 * changed.
 */
export function compactPatterns(
  selected: readonly string[],
  held: readonly string[],
  catalog: readonly string[],
): readonly string[] {
  const on = new Set(selected);
  const kept: string[] = [];
  const consumed = new Set<string>();
  for (const pattern of held.filter(isPattern)) {
    const keys = keysOf(pattern, catalog);
    if (keys.every((key) => on.has(key))) {
      kept.push(pattern);
      for (const key of keys) consumed.add(key);
    }
  }
  return [...kept, ...selected.filter((key) => !consumed.has(key))];
}

/**
 * Why a control in this role's grid cannot be changed: a key its `ceiling`
 * says the role can never hold, or one its `floor` says the Owner always
 * keeps. The ceiling is said first - a key in both would be the server's
 * contradiction, and "can't have" is the one it enforces before the floor.
 */
export type Lock = 'ceiling' | 'floor';

export interface RoleLimits {
  readonly ceiling: ReadonlySet<string>;
  readonly floor: ReadonlySet<string>;
}

/** An action's lock: on the ceiling, it cannot be turned on; on the floor, not off. */
export function keyLock(key: string, limits: RoleLimits): Lock | null {
  if (limits.ceiling.has(key)) return 'ceiling';
  if (limits.floor.has(key)) return 'floor';
  return null;
}

/**
 * A level's lock: it would turn on a ceiling key, or turn off a floor key of
 * this row ("None" on Owner's Roles row, say).
 */
export function levelLock(row: GridRow, level: Level, limits: RoleLimits): Lock | null {
  const keys =
    level === 'none' || !row.ladder
      ? []
      : (row.ladder[level as Exclude<Level, 'none'>] ?? []).map((a) => keyOf(row, a));
  if (keys.some((key) => limits.ceiling.has(key))) return 'ceiling';
  const floorHere = row.permissions.filter((p) => limits.floor.has(p.key));
  if (floorHere.some((p) => !keys.includes(p.key))) return 'floor';
  return null;
}
