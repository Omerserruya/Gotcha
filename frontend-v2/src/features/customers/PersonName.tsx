import { useTranslations } from 'next-intl';

import { UserText } from '@/design-system/primitives/text/UserText';
import { storedShopper, type ShopperKind } from '@/lib/shopper-name';

/**
 * A customer's name as stored - isolated, it is the data's direction - or,
 * for a Shopify visitor stored as "Shopper on <shop>.myshopify.com", our
 * words: "Website shopper" / "קונה באתר" (see shopper-name.ts). A server or
 * a client component may hold it. Only a stored shopper reads the catalogue:
 * a real name needs nothing from it.
 */
export function PersonName({ name }: { readonly name: string }) {
  const kind = storedShopper(name);
  return kind ? <ShopperWords kind={kind} /> : <UserText>{name}</UserText>;
}

function ShopperWords({ kind }: { readonly kind: ShopperKind }) {
  const t = useTranslations('common.person');
  return <>{t(kind)}</>;
}
