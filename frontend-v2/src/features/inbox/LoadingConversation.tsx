'use client';

import { useSearchParams } from 'next/navigation';

import { ConversationSkeleton } from './Skeletons';

/**
 * The inbox loader's conversation panel. A `loading.tsx` is not given the
 * query, so this asks the URL: with a conversation (`?c=`) the Copilot's
 * placeholder is drawn beside it; without one, two panels - the page draws
 * no wall then, and the placeholder must not promise one.
 */
export function LoadingConversation() {
  const open = Boolean(useSearchParams()?.get('c'));
  return <ConversationSkeleton wall={open} />;
}
