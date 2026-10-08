import { auditVerdict, type AuditEntry } from '@/api/contracts/security';

import { auditSentence } from './SecuritySections';

type SecurityT = Parameters<typeof auditSentence>[1];

/** The platform's columns, kept at the end as they came (GET /api/audit-logs/export). */
export const RAW_COLUMNS = [
  'timestamp',
  'action',
  'actor_type',
  'actor_id',
  'target_type',
  'target_id',
  'succeeded',
] as const;

/** One CSV line into its cells: quoted fields, doubled quotes inside them. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/**
 * A cell as the platform writes one: quoted, quotes doubled, and a value a
 * spreadsheet would run as a formula (`=`, `+`, `-`, `@`) led by `'`.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const ACTORS = ['ai', 'user', 'system'] as const;

/**
 * ★ 16's export, readable (supervisor, measured on dev: 8,267 rows of raw
 * keys - "ai.responded","ai",,,). Each row leads with the screen's own words:
 *
 *   when    local time, the app's time zone (the screen's)
 *   what    the screen's sentence for the action
 *   by      GOTCHA, a person by name (one team read), or the system
 *   about   what it was about, where the row says (a conversation, a customer)
 *   worked  Yes / No / Not recorded - `auditVerdict`, the screen's rule: the
 *           row's recorded `succeeded`, else the adapter's ok/err in its name;
 *           anything else is "Not recorded", never left an ambiguous blank
 *
 * then the platform's columns, unchanged, for anyone who wants them.
 */
export function auditCsv({
  t,
  locale,
  timeZone,
  names,
}: {
  readonly t: SecurityT;
  readonly locale: string;
  readonly timeZone: string;
  /** A person's id → their name (or email). Empty when the team could not be read. */
  readonly names: ReadonlyMap<string, string>;
}) {
  const when = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const lead = ['when', 'what', 'by', 'about', 'worked'] as const;

  return {
    header(): string {
      return [...lead.map((k) => t(`audit.csv.${k}`)), ...RAW_COLUMNS].map(csvCell).join(',');
    },

    /** One platform row, readable first. A line that is not a row is passed on, said. */
    row(cells: readonly string[]): string {
      // The platform's own marker for a stream that failed part-way.
      if (cells[0]?.startsWith('EXPORT FAILED')) {
        return [t('audit.csv.incomplete'), '', '', '', '', ...cells].map(csvCell).join(',');
      }
      const [
        timestamp = '',
        action = '',
        actorType = '',
        actorId = '',
        targetType = '',
        targetId = '',
        succeeded = '',
      ] = cells;
      const entry: AuditEntry = {
        id: '',
        actorType,
        actorId: actorId || null,
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        succeeded: succeeded === 'true' ? true : succeeded === 'false' ? false : null,
        createdAt: timestamp,
      } as AuditEntry;
      const at = new Date(timestamp);
      const by =
        (actorType === 'user' && names.get(actorId)) ||
        ((ACTORS as readonly string[]).includes(actorType)
          ? t(`audit.who.${actorType as (typeof ACTORS)[number]}`)
          : t('audit.who.unknown'));
      const about =
        targetType === 'conversation'
          ? t('audit.csv.aboutConversation')
          : targetType === 'contact' || targetType === 'customer'
            ? t('audit.csv.aboutCustomer')
            : '';
      const verdict = auditVerdict(entry.succeeded, action);
      return [
        Number.isNaN(at.getTime()) ? '' : when.format(at),
        auditSentence(entry, t),
        by,
        about,
        t(
          verdict === true
            ? 'audit.csv.yes'
            : verdict === false
              ? 'audit.csv.no'
              : 'audit.csv.notRecorded',
        ),
        timestamp,
        action,
        actorType,
        actorId,
        targetType,
        targetId,
        succeeded,
      ]
        .map(csvCell)
        .join(',');
    },
  };
}
