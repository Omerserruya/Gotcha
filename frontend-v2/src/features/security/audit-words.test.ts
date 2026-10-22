import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { auditEntrySchema } from '@/api/contracts/security';
import he from '@/i18n/messages/he/security.json';

vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(), getLocale: vi.fn() }));

import { auditChipLabel, auditSentence } from './SecuritySections';

/**
 * Every distinct action in dev's audit export (2026-10-08, 8,301 rows) - the
 * platform's real vocabulary, not a guess at it. A new action the platform
 * starts writing is not here, and reads in its own words until it is added.
 */
const DEV_ACTIONS = [
  'action.create_task',
  'action.d49_probe_tool',
  'adapter.err.shopify.add_order_note',
  'adapter.err.shopify.cancel_order',
  'adapter.err.shopify.check_delivery_eta',
  'adapter.err.shopify.create_customer',
  'adapter.err.shopify.create_return',
  'adapter.err.shopify.exchange_order_item',
  'adapter.err.shopify.get_customer',
  'adapter.err.shopify.get_customer_by_email',
  'adapter.err.shopify.get_customer_by_phone',
  'adapter.err.shopify.get_customer_orders',
  'adapter.err.shopify.get_order',
  'adapter.err.shopify.get_orders',
  'adapter.err.shopify.get_product',
  'adapter.err.shopify.get_product_images',
  'adapter.err.shopify.get_shop',
  'adapter.err.shopify.order_lookup',
  'adapter.err.shopify.process_refund',
  'adapter.err.shopify.resend_confirmation',
  'adapter.err.shopify.search_products',
  'adapter.err.shopify.send_invoice',
  'adapter.err.shopify.summarize_customer',
  'adapter.err.shopify.update_customer',
  'adapter.err.shopify.update_my_profile',
  'adapter.err.shopify.update_order_fulfillment',
  'adapter.ok.shopify.add_order_note',
  'adapter.ok.shopify.cancel_order',
  'adapter.ok.shopify.check_refund',
  'adapter.ok.shopify.create_note',
  'adapter.ok.shopify.create_return',
  'adapter.ok.shopify.exchange_order_item',
  'adapter.ok.shopify.find_latest_order',
  'adapter.ok.shopify.get_customer',
  'adapter.ok.shopify.get_customer_by_email',
  'adapter.ok.shopify.get_customer_by_phone',
  'adapter.ok.shopify.get_customer_orders',
  'adapter.ok.shopify.get_fulfillment_status',
  'adapter.ok.shopify.get_order',
  'adapter.ok.shopify.get_order_items',
  'adapter.ok.shopify.get_orders',
  'adapter.ok.shopify.get_product',
  'adapter.ok.shopify.get_product_images',
  'adapter.ok.shopify.get_returns',
  'adapter.ok.shopify.get_shipment_status',
  'adapter.ok.shopify.get_shop',
  'adapter.ok.shopify.get_tracking_url',
  'adapter.ok.shopify.order_lookup',
  'adapter.ok.shopify.process_refund',
  'adapter.ok.shopify.reconcile_order_items',
  'adapter.ok.shopify.resend_confirmation',
  'adapter.ok.shopify.search_customers',
  'adapter.ok.shopify.search_products',
  'adapter.ok.shopify.summarize_customer',
  'adapter.ok.shopify.track_shipment',
  'adapter.ok.shopify.update_customer',
  'adapter.ok.shopify.update_my_profile',
  'adapter.ok.shopify.update_order_shipping_address',
  'adapter.ok.shopify.variant_information',
  'adapter.ok.woocommerce.get_order',
  'adapter.ok.woocommerce.list_orders',
  'adapter.ok.woocommerce.list_products',
  'ai.bot_turn',
  'ai.budget.aborted.tenant_day',
  'ai.budget.aborted.turn',
  'ai.onboarding_preview_answer',
  'ai.output_validator.blocked',
  'ai.paused_for_approval',
  'ai.responded',
  'ai.skill_completed',
  'ai.skill_handed_over',
  'ai.skill_selected',
  'ai.skill_step',
  'ai.tool_call.escalate_to_human',
  'ai.tool_call.integration_order_lookup',
  'ai.tool_call.link_customer_identifier',
  'ai.tool_call.shopify.add_order_note',
  'ai.tool_call.shopify.cancel_order',
  'ai.tool_call.shopify.check_delivery_eta',
  'ai.tool_call.shopify.create_note',
  'ai.tool_call.shopify.create_return',
  'ai.tool_call.shopify.edit_order',
  'ai.tool_call.shopify.exchange_order_item',
  'ai.tool_call.shopify.find_latest_order',
  'ai.tool_call.shopify.get_fulfillment_status',
  'ai.tool_call.shopify.get_order',
  'ai.tool_call.shopify.get_order_items',
  'ai.tool_call.shopify.get_returns',
  'ai.tool_call.shopify.get_shipment_status',
  'ai.tool_call.shopify.order_lookup',
  'ai.tool_call.shopify.process_refund',
  'ai.tool_call.shopify.reconcile_order_items',
  'ai.tool_call.shopify.resend_confirmation',
  'ai.tool_call.shopify.search_products',
  'ai.tool_call.shopify.send_invoice',
  'ai.tool_call.shopify.track_shipment',
  'ai.tool_call.shopify.update_my_profile',
  'ai.tool_call.shopify.update_order_fulfillment',
  'ai.tool_call.shopify.update_order_shipping_address',
  'ai.tool_call.shopify.variant_information',
  'ai.tool_call.woocommerce.get_order',
  'ai.tool_call.woocommerce.list_products',
  'ai.unsupported_action_claim',
  'ai.unsupported_outcome_claim',
  'auth.all_sessions_terminated',
  'billing.paid_tenant_created',
  'billing.payment_continuation_link_created',
  'billing.pending_checkout_created',
  'billing.provisioning_attempted',
  'billing.provisioning_completed',
  'billing.provisioning_request_created',
  'commerce.order_action_executed',
  'commerce.order_action_failed',
  'crm.create_lead.error',
  'crm.link.linked',
  'feature_grant.changed',
  'gdpr.erasure_completed',
  'integration.disconnected',
  'integration.dispatch_decision',
  'message.sent',
  'permission.changed',
  'permission.revoked',
  'security.cross_customer_access_denied',
  'shopify.chat.webhook.app_uninstalled',
  'tenant.created',
  'user.created',
] as const;

/** The only Latin a Hebrew line may hold: names, as they write themselves. */
const BRANDS = /GOTCHA|Shopify|WooCommerce|HubSpot|Salesforce|monday\.com|VIP/g;

const t = createTranslator({
  locale: 'he',
  messages: { security: he },
  namespace: 'security',
}) as never;
const latin = (text: string) => text.replace(BRANDS, '').match(/[A-Za-z]+/g) ?? [];

describe('★★ the audit log in Hebrew: every action dev has written, no English left', () => {
  it.each(DEV_ACTIONS)('%s', (action) => {
    for (const actorType of ['ai', 'user', 'system']) {
      const entry = auditEntrySchema.parse({
        id: 'x',
        actorType,
        action,
        createdAt: '2026-10-08T09:00:00Z',
      });
      const sentence = auditSentence(entry, t);
      expect(latin(sentence), sentence).toEqual([]);
      expect(sentence).not.toMatch(/[{}]/);
      // GOTCHA and the system never take the slash (it is for a person).
      if (actorType !== 'user') expect(sentence, sentence).not.toMatch(/\//);
    }
    const chip = auditChipLabel(action, t);
    expect(latin(chip), chip).toEqual([]);
  });
});
