import { getTranslations } from 'next-intl/server';

import { StateDisplay } from '@/design-system/patterns/StateDisplay';
import { Button } from '@/design-system/primitives/button/Button';
import type { TenantGate } from '@/api/client/tenant-gate';
import { Link } from '@/i18n/navigation';
import { safeInternalPath } from '@/lib/safe-url';

/**
 * What the product says when the platform locks the whole organization out.
 *
 * Every one of these is a different situation with a different person able to
 * fix it, and the backend is explicit that the frontend should branch on the
 * machine-readable `code` rather than on prose. Collapsing them into one
 * message would tell someone whose onboarding is unfinished to go and talk to
 * billing.
 *
 * The set is closed on purpose: an unrecognised code falls back rather than
 * guessing, because inventing a remedy is worse than admitting we have none.
 */
const KNOWN_CODES = [
  'TENANT_PLAN_REQUIRED',
  'TENANT_PAYMENT_REQUIRED',
  'TENANT_SUSPENDED',
  'TENANT_ADMIN_SETUP_REQUIRED',
  'TENANT_ONBOARDING_REQUIRED',
] as const;

export async function TenantGateNotice({ gate }: { gate: TenantGate }) {
  const t = await getTranslations('errors.tenantGate');

  const key = KNOWN_CODES.find((known) => known === gate.code) ?? 'fallback';
  // Backend-supplied; only ever rendered after being proved in-app and relative.
  const target = safeInternalPath(gate.checkoutPath);

  return (
    <StateDisplay
      title={t(`${key}.title`)}
      description={t(`${key}.body`)}
      actions={
        target ? (
          <Button variant="primary" asChild>
            <Link href={target}>{t('action')}</Link>
          </Button>
        ) : undefined
      }
    />
  );
}
