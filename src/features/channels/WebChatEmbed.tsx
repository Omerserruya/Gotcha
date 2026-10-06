'use client';

import { useRouter } from '@/i18n/navigation';

import { EmbedSnippet } from './ConnectPanel';

/** The embed code on the web chat's own row - its Settings, and where Create lands. */
export function WebChatEmbed({ widgetId }: { readonly widgetId: string }) {
  const router = useRouter();
  return (
    <EmbedSnippet
      widgetId={widgetId}
      onClose={() => router.replace('/settings/channels', { scroll: false })}
    />
  );
}
