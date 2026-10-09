import { createNavigation } from 'next-intl/navigation';

import { routing } from './routing';

/**
 * Locale-aware navigation.
 *
 * Product code imports `Link` and `useRouter` from here, never from
 * `next/link` or `next/navigation`, so that the active locale prefix is
 * carried automatically and no component has to remember it.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
