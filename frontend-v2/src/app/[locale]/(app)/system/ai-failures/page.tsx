import { getTranslations } from 'next-intl/server';

import { hoursOf } from '@/api/contracts/ai-failures';
import { AiFailures } from '@/features/console/AiFailures';
import { loadAiFailures, loadTenantNames } from '@/features/console/load-ai-failures';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

/**
 * Console · "פעולות AI שנכשלו" (Omer, 2026-11-18): the AI's tool calls that
 * failed, timed out or were refused, across tenants. SYSTEM_ADMIN only, behind
 * the console's door; nothing of it in a tenant's screens. Server-rendered,
 * no polling: the filters are the address.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly hours?: string | string[];
    readonly tenantId?: string | string[];
    readonly tool?: string | string[];
  }>;
}) {
  // The layout draws the unread state; the page reads nothing behind it.
  if ((await requireConsole()) !== 'open') return null;
  const params = await searchParams;
  const filters = {
    hours: hoursOf(one(params.hours)),
    tenantId: one(params.tenantId),
    tool: one(params.tool),
  };
  const [t, data, names] = await Promise.all([
    getTranslations('console.aiFailures'),
    loadAiFailures(filters),
    loadTenantNames(),
  ]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {data === null ? (
        <p className={styles.quiet} role="alert" data-testid="ai-failures-unread">
          {t('unread')}
        </p>
      ) : (
        <AiFailures data={data} filters={filters} names={names} />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.aiFailures', 'console');
