import {
  platformSenderSchema,
  platformTemplateListSchema,
  type PlatformSender,
  type PlatformTemplate,
} from '@/api/contracts/platform-whatsapp';

/**
 * The contract's shapes (Backend 582f50a4), parsed by the real schema, so a
 * fixture can only claim what the route can send ([[fixture-is-a-claim]]).
 */
export function sender(over: Record<string, unknown> = {}): PlatformSender {
  return platformSenderSchema.parse({
    status: 'CONNECTED',
    source: 'db',
    envPresent: false,
    number: {
      display: '+972 50 000 0000',
      verifiedName: 'GOTCHA',
      phoneNumberId: 'pn_1',
      wabaId: 'waba_1',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
    },
    connectedAt: '2026-11-15T10:00:00.000Z',
    connectedBy: { id: 'u1', name: 'Omer' },
    disconnectedAt: null,
    lastErrorCode: null,
    lastError: null,
    launch: { appId: 'app', configId: 'cfg', extras: {}, configured: true },
    ...over,
  });
}

/** A Hebrew body for the Hebrew row: a fixture claims what the route sends. */
export const HE_BODY = 'לקוח ממתין: {{1}}, {{2}}.';

export const language = (over: Record<string, unknown> = {}) => ({
  body: 'A customer is waiting: {{1}}, {{2}}.',
  draftBody: null,
  status: 'NOT_SUBMITTED',
  rejectedReason: null,
  metaTemplateId: null,
  submittedAt: null,
  lastSyncedAt: null,
  ...over,
});

export function template(over: Record<string, unknown> = {}): PlatformTemplate {
  return platformTemplateListSchema.parse([
    {
      eventType: 'conversation.waiting',
      name: 'gotcha_customer_waiting',
      category: 'UTILITY',
      parameterCount: 2,
      buttons: { url: true, quickReplies: 0, copyCode: false },
      alertEnabled: false,
      toggleable: true,
      editable: true,
      canEnable: false,
      languages: { he: language({ body: HE_BODY }), en: language() },
      ...over,
    },
  ])[0]!;
}

/** The eight, in the console's order (platform-templates.ts catalogue). */
export const EIGHT: readonly [string, string, boolean, boolean][] = [
  ['tool.approval_required', 'gotcha_approval_request', true, true],
  ['tool.approval_required.review', 'gotcha_approval_required', false, true],
  ['conversation.escalated', 'gotcha_conversation_escalated', true, true],
  ['tool.action_failed', 'gotcha_action_failed', true, true],
  ['credit.threshold', 'gotcha_credit_low', true, true],
  ['credit.exhausted', 'gotcha_credit_exhausted', true, true],
  ['conversation.waiting', 'gotcha_customer_waiting', true, true],
  ['verification', 'gotcha_verification_code', false, false],
];

export const allEight = (over: Record<string, unknown> = {}) =>
  EIGHT.map(([eventType, name, toggleable, editable]) =>
    template({
      eventType,
      name,
      toggleable,
      editable,
      category: editable ? 'UTILITY' : 'AUTHENTICATION',
      ...over,
    }),
  );
