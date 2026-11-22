import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ EVERY CONTROL SUPPORT MODE REFUSES IS DRAWN REFUSED (Omer, 2026-11-01).
 *
 * The list is Omer's, plus what Backend refuses on the same lines (role and
 * grant edits, 2026-11-01). Each row names the action and the file where its
 * control is drawn, and that file must gate it: `<SupportRefused kind=…>`
 * around the control, or `useSupport().refuses(…)` inside it.
 *
 * ⚠ Granularity: by file and by text. It proves each named site gates, not
 *   that the gate wraps the right element - SupportRefused.test.tsx and the
 *   screens' own tests do that. A NEW component calling one of these actions
 *   fails the sweep below (CALLERS); a known component drawn on a NEW screen
 *   is not seen by either.
 */
const SRC = join(__dirname, '..');

const SITES: ReadonlyArray<readonly [action: string, kind: string, files: readonly string[]]> = [
  ['buyCreditPack', 'billing', ['app/[locale]/(app)/settings/billing/page.tsx']],
  ['saveBillingProfile', 'billing', ['features/billing/BillingProfile.tsx']],
  ['startCardSession', 'billing', ['features/billing/BillingProfile.tsx']],
  [
    'confirmCardSession',
    'billing',
    ['app/[locale]/(app)/settings/billing/payment-method/page.tsx'],
  ],
  ['saveAutoPurchase', 'billing', ['features/billing/AutoPurchase.tsx']],
  ['previewPlanChange', 'billing', ['features/billing/PlanChoice.tsx']],
  ['changePlanTo', 'billing', ['features/billing/PlanChoice.tsx']],
  ['chooseShopifyPlan', 'billing', ['features/billing/ConnectorSection.tsx']],
  ['openCheckout', 'billing', ['app/[locale]/(checkout)/checkout/page.tsx']],
  [
    'startCheckoutPayment',
    'billing',
    [
      'app/[locale]/(checkout)/checkout/failed/page.tsx',
      'app/[locale]/(checkout)/checkout/payment-required/page.tsx',
    ],
  ],
  ['changeRole', 'ownership', ['features/roles/PersonPanel.tsx']],
  ['removePermission', 'ownership', ['features/roles/PersonPanel.tsx']],
  ['addPermission', 'ownership', ['app/[locale]/(app)/settings/people/page.tsx']],
  [
    'createRole',
    'ownership',
    [
      'app/[locale]/(app)/settings/people/roles/new/page.tsx',
      'app/[locale]/(app)/settings/people/roles/edit/[roleId]/page.tsx',
    ],
  ],
  ['inviteMember', 'ownership', ['features/people/InviteForm.tsx']],
  ['revokeSession', 'ownership', ['app/[locale]/(app)/settings/security/page.tsx']],
  ['setMfaPolicy', 'ownership', ['app/[locale]/(app)/settings/security/page.tsx']],
  [
    'deleteConversation',
    'delete',
    // Swipe-to-delete (2026-11-22) gates with refuses('delete') too.
    ['features/inbox/QueueMenu.tsx', 'features/inbox/RowDelete.tsx'],
  ],
  ['deleteEmployee', 'delete', ['features/employees/EmployeeDetail.tsx']],
  ['disconnectChannel', 'delete', ['features/channels/ChannelList.tsx']],
  ['disconnectNumber', 'delete', ['features/channels/PanelFoot.tsx']],
  [
    'disconnectSystem',
    'delete',
    [
      'app/[locale]/(app)/studio/capabilities/page.tsx',
      'features/capabilities/ReconnectSystem.tsx',
      'features/capabilities/SystemHead.tsx',
    ],
  ],
  ['removeWooSite', 'delete', ['features/webchat/WooPlugin.tsx']],
];

/** The `.tsx` files that call each action today - the components the gates above wrap. */
const CALLERS: Readonly<Record<string, readonly string[]>> = {
  buyCreditPack: [
    'app/[locale]/(app)/settings/billing/page.tsx',
    'features/billing/BuyCredits.tsx',
  ],
  saveBillingProfile: ['features/billing/ProfileForm.tsx'],
  startCardSession: ['features/billing/CardSession.tsx'],
  confirmCardSession: ['features/billing/CardReturn.tsx'],
  saveAutoPurchase: ['features/billing/AutoPurchaseForm.tsx'],
  previewPlanChange: ['features/billing/PlanSwitch.tsx'],
  changePlanTo: ['features/billing/PlanSwitch.tsx'],
  chooseShopifyPlan: ['features/billing/ConnectorCta.tsx'],
  openCheckout: ['features/checkout/CheckoutOpen.tsx'],
  startCheckoutPayment: ['features/checkout/PayButton.tsx'],
  changeRole: ['features/roles/ChangeRole.tsx'],
  removePermission: ['features/roles/RemovePermission.tsx'],
  addPermission: ['features/roles/GrantPicker.tsx', 'features/roles/PersonPanel.tsx'],
  createRole: ['features/roles/RoleForm.tsx'],
  inviteMember: ['features/people/InviteForm.tsx'],
  revokeSession: ['features/security/SessionList.tsx'],
  setMfaPolicy: ['features/security/MfaPolicy.tsx'],
  deleteConversation: ['features/inbox/QueueMenu.tsx', 'features/inbox/RowDelete.tsx'],
  deleteEmployee: ['features/employees/DeleteEmployee.tsx'],
  disconnectChannel: ['features/channels/DisconnectChannel.tsx'],
  disconnectNumber: ['features/channels/PanelFoot.tsx'],
  disconnectSystem: ['features/capabilities/DisconnectSystem.tsx'],
  removeWooSite: ['features/webchat/WooPlugin.tsx'],
};

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : tsxUnder(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

describe('★★ every refused control is gated where it is drawn', () => {
  it.each(SITES.flatMap(([action, kind, files]) => files.map((file) => [action, kind, file])))(
    '%s (%s) in %s',
    (_action, kind, file) => {
      const source = read(file);
      const gated =
        source.includes(`<SupportRefused kind="${kind}">`) || source.includes(`refuses('${kind}')`);
      expect(gated, `${file} draws a control support mode refuses, ungated`).toBe(true);
    },
  );
});

describe('★ no new component calls a refused action unseen', () => {
  const files = tsxUnder(SRC).map((path) => ({
    file: relative(SRC, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));

  it('every action in the table has its callers listed', () => {
    expect(Object.keys(CALLERS).sort()).toEqual([...new Set(SITES.map(([a]) => a))].sort());
  });

  it.each(Object.entries(CALLERS))('%s is called only where the table says', (action, known) => {
    const calling = files
      .filter(({ source }) => new RegExp(`\\b${action}\\b`).test(source))
      .map(({ file }) => file)
      .sort();
    expect(calling).toEqual([...known].sort());
  });
});
