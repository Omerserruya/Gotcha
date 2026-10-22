import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { employeeKnowledgeListSchema, type EmployeeKnowledgeSource } from './knowledge-plan';

/** Every knowledge base in the workspace, with its scope; `null` when the read failed. */
export async function loadEmployeeKnowledge(): Promise<readonly EmployeeKnowledgeSource[] | null> {
  try {
    return await serverApi().get({
      endpoint: knowledgeEndpoints.sources(),
      payload: employeeKnowledgeListSchema,
    });
  } catch (cause) {
    logger.warn('employees.knowledge_failed', { cause });
    return null;
  }
}
