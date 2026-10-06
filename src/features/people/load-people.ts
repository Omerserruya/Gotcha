import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  aiEmployeesSchema,
  departmentsSchema,
  isBuilderDraft,
  membersSchema,
  type AiEmployee,
  type Department,
  type Member,
} from '@/api/contracts/people';
import { presenceRosterSchema, type AgentPresence } from '@/api/contracts/presence';
import {
  aiEmployeeEndpoints,
  departmentEndpoints,
  permissionEndpoints,
  presenceEndpoints,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Everything screen 12 shows.
 *
 * Four independent reads. One failing must not blank the others: a tenant
 * whose AI employees would not load can still see its people, and an admin who
 * can still read the member list is better served than one shown a single
 * error for the whole page.
 *
 * `null` means the call failed. It is never conflated with empty - a tenant
 * with no teams and a tenant whose teams would not load look identical on
 * screen otherwise, and only one of them is safe to leave alone. Presence is
 * the exception and defaults to `[]`: no presence row genuinely means offline,
 * which is what the backend itself returns for an agent that never sent a
 * heartbeat, so a failed read and an empty one say the same thing here.
 */
export interface PeopleData {
  readonly members: readonly Member[] | null;
  readonly aiEmployees: readonly AiEmployee[] | null;
  readonly teams: readonly Department[] | null;
  readonly presence: readonly AgentPresence[];
}

export async function loadPeople(): Promise<PeopleData> {
  const api = serverApi();

  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      logger.warn(event, { cause });
      return value;
    };

  const [members, aiEmployees, teams, presence] = await Promise.all([
    api
      .get({ endpoint: permissionEndpoints.users(), payload: membersSchema })
      .catch(degrade('people.members_failed', null)),
    api
      .get({ endpoint: aiEmployeeEndpoints.list(), payload: aiEmployeesSchema })
      .catch(degrade('people.ai_employees_failed', null)),
    api
      .get({ endpoint: departmentEndpoints.list(), payload: departmentsSchema })
      .catch(degrade('people.teams_failed', null)),
    api
      .get({ endpoint: presenceEndpoints.roster(), payload: presenceRosterSchema })
      .catch(degrade('people.presence_failed', [])),
  ]);

  return {
    members,
    // An abandoned creation wizard is not a colleague. The backend's own rule
    // excludes `DRAFT` + a builder step from the employee list, and a half-made
    // employee appearing in the team roster would be a person who does not
    // exist yet.
    aiEmployees: aiEmployees?.filter((ai) => !isBuilderDraft(ai)) ?? null,
    teams,
    presence,
  };
}
