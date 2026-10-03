import {
  PRIMARY_NAVIGATION,
  SETTINGS_NAVIGATION,
  SETTINGS_SECTIONS,
  type NavigationItem,
} from './navigation';

/**
 * 19's GO TO, for screens: every destination the rail knows, as one flat
 * list — a primary destination, each of its children (an Inbox view is
 * `/inbox?view=…`), and Settings' sections. Filtered by the same permission
 * check the rail uses, so the palette never offers a screen the rail hides.
 */
export interface Destination {
  readonly id: string;
  readonly href: string;
  /** Message keys under `navigation`: the parent's, then its own. */
  readonly labelKeys: readonly string[];
}

export function destinations(canSee: (permission?: string) => boolean): readonly Destination[] {
  const out: Destination[] = [];
  const add = (item: NavigationItem) => {
    if (!canSee(item.permission)) return;
    out.push({ id: item.id, href: item.href, labelKeys: [item.labelKey] });
    for (const child of item.children ?? []) {
      if (!canSee(child.permission)) continue;
      const href =
        child.href ??
        (item.viewParam && child.view ? `${item.href}?${item.viewParam}=${child.view}` : null);
      if (href && href !== item.href) {
        out.push({
          id: `${item.id}.${child.id}`,
          href,
          labelKeys: [item.labelKey, child.labelKey],
        });
      }
    }
  };
  PRIMARY_NAVIGATION.forEach(add);
  if (canSee(SETTINGS_NAVIGATION.permission)) {
    add({ ...SETTINGS_NAVIGATION, children: SETTINGS_SECTIONS });
  }
  return out;
}

/** Destinations whose label contains every word typed, in any order. */
export function matching<T extends { readonly label: string }>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const label = item.label.toLocaleLowerCase();
    return words.every((word) => label.includes(word));
  });
}
