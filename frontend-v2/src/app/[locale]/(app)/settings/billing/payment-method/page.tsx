import { getTranslations } from 'next-intl/server';

import { CardReturn } from '@/features/billing/CardReturn';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Usage & billing · Card - where the payment provider's hosted
 * page returns (Backend builds it unprefixed; the locale is the reader's own,
 * by v2's routing). `?cancelled=1` when they left without saving one.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly cancelled?: string }>;
}) {
  const t = await getTranslations('billing.card');
  const nav = await getTranslations('navigation');
  const cancelled = (await searchParams)?.cancelled === '1';
  return (
    <SettingsSection
      title={t('title')}
      back={{ href: '/settings/billing', label: nav('settings.billing') }}
    >
      <CardReturn cancelled={cancelled} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billing');
