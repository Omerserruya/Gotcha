import { useTranslations } from 'next-intl';

import { PLAN_ACCESS_STATES, type PlanAccess } from '@/api/contracts/console';
import {
  StatusIndicator,
  type StatusTone,
} from '@/design-system/primitives/status/StatusIndicator';
import { UserText } from '@/design-system/primitives/text/UserText';

import type { TenantBillingState } from './billing-state';

const ACTIVE_PLAN = new Set([
  'ACTIVE_PAID',
  'ACTIVE_POC',
  'ACTIVE_TRIAL',
  'ACTIVE_MANUAL_CONTRACT',
]);

const isKnownPlanState = (state: string): state is (typeof PLAN_ACCESS_STATES)[number] =>
  (PLAN_ACCESS_STATES as readonly string[]).includes(state);

/**
 * A tenant's plan, always present (legacy `PlanAccessBadge`): an apparently
 * healthy tenant is never drawn with an empty plan field. No verdict reads
 * "Plan unknown", never nothing. Every state that needs a person is amber -
 * the design has no red; the words carry the weight ("No plan, needs action").
 */
export function PlanAccessBadge({ access }: { readonly access: PlanAccess | null }) {
  const t = useTranslations('console.plan');
  if (!access) return <StatusIndicator tone="neutral">{t('unknown')}</StatusIndicator>;
  if (!isKnownPlanState(access.state)) {
    // A state this build has not named: the route's own label, as data.
    return (
      <span data-testid="plan-unnamed">
        <UserText>{access.label || access.state}</UserText>
      </span>
    );
  }
  const tone: StatusTone = ACTIVE_PLAN.has(access.state) ? 'done' : 'waiting';
  return <StatusIndicator tone={tone}>{t(access.state)}</StatusIndicator>;
}

/**
 * Pending payment and billing setup incomplete - two operator problems, never
 * one badge (legacy `BillingStatusBadge`). Nothing for the other states: the
 * tenant's status says those.
 */
export function BillingStatusBadge({ state }: { readonly state: TenantBillingState }) {
  const t = useTranslations('console.billing');
  if (state === 'ACTIVE' || state === 'OTHER') return null;
  return (
    <StatusIndicator tone={state === 'BILLING_UNREAD' ? 'neutral' : 'waiting'}>
      {t(state)}
    </StatusIndicator>
  );
}

const STATUS_TONE: Record<string, StatusTone> = {
  ACTIVE: 'done',
  PENDING_ADMIN_SETUP: 'waiting',
  PENDING_ONBOARDING: 'waiting',
  SUSPENDED: 'neutral',
};

/**
 * The tenant's own status. Disabled outranks it - a disabled ACTIVE tenant
 * cannot sign in, and "Active" beside it would say otherwise. An awaiting-
 * payment tenant is the billing badge's, which knows which of two it is.
 */
export function TenantStatusBadge({
  status,
  isActive,
  billing,
}: {
  readonly status: string;
  readonly isActive: boolean;
  readonly billing: TenantBillingState;
}) {
  const t = useTranslations('console.status');
  if (!isActive) return <StatusIndicator tone="neutral">{t('disabled')}</StatusIndicator>;
  if (status === 'PENDING_PAYMENT') return <BillingStatusBadge state={billing} />;
  const tone = STATUS_TONE[status];
  if (!tone) return <UserText>{status}</UserText>;
  return <StatusIndicator tone={tone}>{t(status as keyof typeof STATUS_TONE)}</StatusIndicator>;
}
