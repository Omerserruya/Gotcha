import { getTranslations } from 'next-intl/server';

import {
  SkeletonCards,
  SkeletonRows,
  SkeletonStats,
} from '@/design-system/primitives/skeleton/Skeleton';

import { PageContainer } from './PageContainer';

export type RoutePreset = 'rows' | 'cards' | 'stats';

/**
 * A route's `loading.tsx` (Omer, 2026-10-07): what Next shows the moment a
 * navigation starts - it is prefetched with the route - so the page's real
 * title is there at once and its content is placeholders until it streams.
 *
 * ★ PER ROUTE, NOT ONE FOR ALL. A `loading.tsx` covers a navigation INTO its
 *   own segment; one at `(app)` sat above Studio's and Settings' shared
 *   layouts, so moving between two Studio pages had no boundary at all and
 *   the old page stayed on screen until the new one was whole (measured on
 *   dev, 7s throttle).
 *
 * The title is the route's own label - the key its page passes to
 * `pageMetadata`, so the two cannot drift.
 */
export async function RouteLoading({
  label,
  preset = 'rows',
}: {
  /** The page's `pageMetadata` key, in `navigation`. */
  readonly label: string;
  readonly preset?: RoutePreset;
}) {
  const nav = await getTranslations('navigation');
  const common = await getTranslations('common');
  const loading = common('loading');
  return (
    <PageContainer layout="screen" title={nav(label)}>
      <div data-testid="route-loading" data-preset={preset}>
        {preset === 'cards' ? (
          <SkeletonCards label={loading} count={6} />
        ) : preset === 'stats' ? (
          <>
            <SkeletonStats label={loading} count={4} />
            <SkeletonRows label={loading} rows={5} />
          </>
        ) : (
          <SkeletonRows label={loading} rows={8} />
        )}
      </div>
    </PageContainer>
  );
}
