import { Skeleton, SkeletonRegion } from '@/design-system/primitives/skeleton/Skeleton';

import styles from './mobile-skeletons.module.css';

/**
 * The phone's screens while they load (`loading.tsx` under `/m`), each in
 * its own shape: the list's search and chips and rows, Home's greeting and
 * dark card, a conversation's bubbles, a request's card, a customer's face.
 *
 * ★ THE SHAPE OF THE SCREEN, NOT A SPINNER. The bar is drawn for real by the
 *   route (its title, its way back), so the top of the screen does not jump
 *   when the page arrives; only what has to be read stands in here. Each one
 *   is a region that says it is loading, once (`SkeletonRegion`), with the
 *   caller's label - the shapes are hidden from screen readers.
 */

/** Two text lines of a row, at widths that vary by index so a list does not look stamped. */
function Lines({
  index,
  first = 46,
  second = 30,
}: {
  readonly index: number;
  readonly first?: number;
  readonly second?: number;
}) {
  return (
    <span className={styles.lines}>
      <Skeleton shape="text" width={`${first - (index % 3) * 8}%`} height="15px" />
      {second > 0 ? (
        <Skeleton shape="text" width={`${second + (index % 2) * 14}%`} height="12px" />
      ) : null}
    </span>
  );
}

function Chips({ count }: { readonly count: number }) {
  return (
    <div className={styles.chips}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={styles.chip} style={{ inlineSize: `${64 + (i % 3) * 18}px` }} />
      ))}
    </div>
  );
}

/** A list screen: the inbox, the customers, the campaigns. */
export function MobileListSkeleton({
  label,
  search = false,
  chips = 0,
  lead = false,
  section = false,
  rows = 7,
  testid = 'mobile-list-skeleton',
}: {
  readonly label: string;
  /** The search pill over the chips (inbox, customers). */
  readonly search?: boolean;
  /** How many chips stand in for the filter row; 0 draws none. */
  readonly chips?: number;
  /** The screen's lead line under its title. */
  readonly lead?: boolean;
  /** A section label above the rows (outreach's "in progress"). */
  readonly section?: boolean;
  readonly rows?: number;
  readonly testid?: string;
}) {
  return (
    <div className={styles.scroll}>
      <SkeletonRegion label={label}>
        <div data-testid={testid}>
          {search ? <div className={styles.search} /> : null}
          {lead ? (
            <div className={styles.lead}>
              <Skeleton shape="text" width="72%" height="14px" />
            </div>
          ) : null}
          {chips > 0 ? <Chips count={chips} /> : null}
          {section ? (
            <div className={styles.section}>
              <Skeleton shape="text" width="22%" height="12px" />
            </div>
          ) : null}
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className={styles.row}>
              <Skeleton shape="circle" width="50px" height="50px" />
              <Lines index={i} />
            </div>
          ))}
        </div>
      </SkeletonRegion>
    </div>
  );
}

/** Home: the greeting, the day's dark card, who needs you, the updates. */
export function MobileHomeSkeleton({ label }: { readonly label: string }) {
  return (
    <div className={styles.scroll}>
      <SkeletonRegion label={label}>
        <div className={styles.home} data-testid="mobile-home-skeleton">
          <div className={styles.greeting}>
            <Skeleton shape="text" width="34%" height="13px" />
            <Skeleton width="62%" height="30px" />
          </div>
          <div className={styles.summary} aria-hidden="true">
            <span className={styles.summaryLine} />
            <div className={styles.tiles}>
              <span className={styles.tile} />
              <span className={styles.tile} />
              <span className={styles.tile} />
            </div>
          </div>
          <div className={styles.block}>
            <Skeleton shape="text" width="26%" height="17px" />
            <div className={styles.card}>
              {Array.from({ length: 2 }, (_, i) => (
                <Lines key={i} index={i} first={60} second={80} />
              ))}
            </div>
          </div>
          <div className={styles.block}>
            <Skeleton shape="text" width="20%" height="17px" />
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={styles.update}>
                <Skeleton width="40px" height="40px" />
                <Lines index={i} first={70} second={0} />
              </div>
            ))}
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}

/** A conversation: its bubbles from both sides on the thread's ground, and the composer. */
export function MobileThreadSkeleton({ label }: { readonly label: string }) {
  const bubbles = [
    { side: 'in', width: 62, height: 40 },
    { side: 'out', width: 70, height: 56 },
    { side: 'in', width: 48, height: 40 },
    { side: 'out', width: 58, height: 40 },
    { side: 'in', width: 74, height: 56 },
  ] as const;
  return (
    <div className={styles.thread}>
      <SkeletonRegion label={label}>
        <div className={styles.stream} data-testid="mobile-thread-skeleton">
          {bubbles.map((bubble, i) => (
            <div key={i} className={styles.bubble} data-side={bubble.side}>
              <Skeleton width={`${bubble.width}%`} height={`${bubble.height}px`} />
            </div>
          ))}
        </div>
      </SkeletonRegion>
      <div className={styles.composer} aria-hidden="true" />
    </div>
  );
}

/** The approvals: the lead line, the chips, and request cards with their two buttons. */
export function MobileCardsSkeleton({
  label,
  cards = 2,
  chips = 2,
}: {
  readonly label: string;
  readonly cards?: number;
  readonly chips?: number;
}) {
  return (
    <div className={styles.scroll}>
      <SkeletonRegion label={label}>
        <div data-testid="mobile-cards-skeleton">
          <div className={styles.lead}>
            <Skeleton shape="text" width="78%" height="14px" />
          </div>
          {chips > 0 ? <Chips count={chips} /> : null}
          <div className={styles.cards}>
            {Array.from({ length: cards }, (_, i) => (
              <div key={i} className={styles.card}>
                <Skeleton shape="text" width="30%" height="12px" />
                <Skeleton shape="text" width={`${70 - i * 12}%`} height="19px" />
                <Skeleton shape="text" width="88%" height="13px" />
                <div className={styles.buttons} aria-hidden="true">
                  <span className={styles.button} />
                  <span className={styles.button} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}

/** One customer: the face, the name and phone, the three tiles, the history card. */
export function MobileProfileSkeleton({ label }: { readonly label: string }) {
  return (
    <div className={styles.scroll}>
      <SkeletonRegion label={label}>
        <div data-testid="mobile-profile-skeleton">
          <div className={styles.profile}>
            <Skeleton shape="circle" width="84px" height="84px" />
            <Skeleton shape="text" width="44%" height="22px" />
            <Skeleton shape="text" width="32%" height="14px" />
            <div className={styles.profileTiles} aria-hidden="true">
              <span className={styles.profileTile} />
              <span className={styles.profileTile} />
              <span className={styles.profileTile} />
            </div>
          </div>
          <div className={styles.cards}>
            <div className={styles.card}>
              <Skeleton shape="text" width="40%" height="15px" />
              {Array.from({ length: 4 }, (_, i) => (
                <Lines key={i} index={i} first={66} second={40} />
              ))}
            </div>
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}

/** One request or one campaign: a single tall card under the bar. */
export function MobileDetailSkeleton({
  label,
  testid = 'mobile-detail-skeleton',
}: {
  readonly label: string;
  readonly testid?: string;
}) {
  return (
    <div className={styles.scroll}>
      <SkeletonRegion label={label}>
        <div className={styles.detail} data-testid={testid}>
          <Skeleton shape="text" width="36%" height="13px" />
          <Skeleton width="80%" height="28px" />
          <Skeleton shape="text" width="60%" height="14px" />
          <div className={styles.card}>
            {Array.from({ length: 4 }, (_, i) => (
              <Lines key={i} index={i} first={70} second={50} />
            ))}
          </div>
          <div className={styles.buttons} aria-hidden="true">
            <span className={styles.button} />
            <span className={styles.button} />
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}
