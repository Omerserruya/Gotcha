import 'server-only';

import {
  departmentsSchema,
  membersSchema,
  type Department,
  type Member,
} from '@/api/contracts/people';
import { rulesSchema, type NotificationRule } from '@/api/contracts/notification-rules';
import { serverApi } from '@/api/client/server-api';
import {
  departmentEndpoints,
  notificationEndpoints,
  permissionEndpoints,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Everything screen 15 shows.
 *
 * `GET /api/notification-preferences` - ADMIN only, `{ data }` enveloped. This
 * is the table the dispatcher reads; the per-user store the design drew is
 * read by nothing but its own route.
 *
 * Departments and members are fetched because a rule names neither. It stores
 * a `departmentId` and, for `type: 'users'`, an array of user ids - so without
 * these two reads the screen would render cuids where a team and a person
 * belong, which is the defect that shipped `ai_voice` onto the billing screen.
 *
 * Each read degrades on its own. A tenant whose departments will not load can
 * still see its rules; it just cannot name the team one is scoped to, and the
 * screen says that rather than inventing a name or hiding the rule.
 *
 * `rules: null` means the read failed, and is never conflated with an empty
 * list. The difference is the whole day-one state: no rules means GOTCHA's
 * own route (in-app, no email - notifications 9164a058), a real configuration
 * an admin must be able to see; a failed read means they learned nothing.
 */
export interface RulesData {
  readonly rules: readonly NotificationRule[] | null;
  readonly departments: readonly Department[] | null;
  readonly members: readonly Member[] | null;
}

export async function loadRules(): Promise<RulesData> {
  const api = serverApi();

  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      logger.warn(event, { cause });
      return value;
    };

  const [rules, departments, members] = await Promise.all([
    api
      .get({ endpoint: notificationEndpoints.rules(), payload: rulesSchema })
      .catch(degrade('notification_rules.read_failed', null)),
    api
      .get({ endpoint: departmentEndpoints.list(), payload: departmentsSchema })
      .catch(degrade('notification_rules.departments_failed', null)),
    api
      .get({ endpoint: permissionEndpoints.users(), payload: membersSchema })
      .catch(degrade('notification_rules.members_failed', null)),
  ]);

  return { rules, departments, members };
}
