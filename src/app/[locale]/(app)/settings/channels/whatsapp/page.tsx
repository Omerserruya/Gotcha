import { getTranslations } from 'next-intl/server';

import { loadWhatsAppNumbers } from '@/features/channels/load-whatsapp';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · WhatsApp numbers — screen 13.
 *
 * Separate from the channel list because a WhatsApp number has a lifecycle the
 * other channels do not: per-number health, repairs that belong to three
 * different parties, and an audit trail. Folding it into the list would
 * flatten all of that into one connected/disconnected badge — which is the
 * collapse the platform already paid for once, when a number receiving
 * customer messages reported as "0 working, 1 needs attention".
 *
 * **On this tenant the only card that renders is the unprofiled one**: the
 * workspace has one WhatsApp channel, connected before per-number health
 * existed, so `data` is empty and `unprofiled` has a single entry.
 */
export default async function Page() {
  const t = await getTranslations('channels.whatsapp');
  const numbers = await loadWhatsAppNumbers();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <WhatsAppNumbers numbers={numbers} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.whatsapp');
