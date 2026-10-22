import 'server-only';

import { currentUserSchema } from '@/api/contracts/identity';
import { personDetailSchema, type Person } from '@/api/contracts/roles';
import { authEndpoints, permissionEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * One person - screen 12d.
 *
 * `raw` because the transform needs the `{ data }` envelope intact: the route
 * nests `user` inside it beside `roles`, `grants` and the effective
 * `permissions`, and flattening happens in the contract rather than here.
 */
export async function loadPerson(userId: string): Promise<Person | null> {
  try {
    return await serverApi().get({
      endpoint: permissionEndpoints.user(userId),
      payload: personDetailSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('person.load_failed', { cause, userId });
    return null;
  }
}

/**
 * Who is looking - `/auth/me`'s `user.id`, the same `User.id` the member
 * routes use - so 12d knows when the drawer is the viewer's OWN. `null` when
 * unread: then no drawer is taken to be theirs.
 */
export async function loadViewerId(): Promise<string | null> {
  try {
    const me = await serverApi().get({ endpoint: authEndpoints.me(), payload: currentUserSchema });
    return me.user.id;
  } catch (cause) {
    logger.warn('person.me_failed', { cause });
    return null;
  }
}
