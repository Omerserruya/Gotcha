import { Suspense } from 'react';

import { AutomationsPending } from '@/features/automations/AutomationsList';
import { ListSection } from '@/features/automations/AutomationsPage';
import { templateOf } from '@/features/automations/templates';
import { pageMetadata } from '@/shell/page-metadata';

import { AutomationsFrame } from './frame';

/**
 * 09c - Studio · Automations (design 6), over `/api/automations`.
 *
 * The table is the route's: each automation's trigger and path, this week's
 * runs, the last run, who paused it. New automation opens the trigger
 * picker (09e, first step) over this list (`?new=1`).
 *
 * ★ Templates (Omer, 2026-10-07: anything that looks like an action does
 *   something real): one that runs today opens New automation prefilled
 *   (`?template=`) - a draft with its steps, never turned on; one whose
 *   trigger has no event source yet is a status, unmistakably - "Coming
 *   soon", quiet, no hover, `aria-disabled`, the reason as its line - and
 *   does nothing.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly new?: string;
    readonly deleted?: string;
    /** A template chosen: New automation, prefilled. */
    readonly template?: string;
  }>;
} = {}) {
  const params = (await searchParams) ?? {};
  const creating = params.new === '1';
  const chosen = templateOf(params.template);
  const fromTemplate = chosen?.build ? chosen.key : null;

  return (
    <AutomationsFrame deleted={params.deleted === '1'}>
      {/* The list streams behind its placeholder; everything around it is static. */}
      <Suspense fallback={<AutomationsPending />}>
        <ListSection creating={creating} fromTemplate={fromTemplate} />
      </Suspense>
    </AutomationsFrame>
  );
}

export const generateMetadata = pageMetadata('studio.automations');
