import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { skillsListSchema } from '@/api/contracts/skills';
import { skillEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { HireSkill } from './hire-plan';

/**
 * The business skills a hire may carry (H4): the library, archived left
 * out. `null` when the read failed - never "no skills".
 */
export async function loadHireSkills(): Promise<readonly HireSkill[] | null> {
  try {
    const { data } = await serverApi().get({
      endpoint: skillEndpoints.list(),
      payload: skillsListSchema,
      raw: true,
    });
    return data.flatMap((skill) =>
      skill.status === 'archived'
        ? []
        : [{ id: skill.id, name: skill.name, situation: skill.situation, status: skill.status }],
    );
  } catch (cause) {
    logger.warn('employees.hire_skills_failed', { cause });
    return null;
  }
}
