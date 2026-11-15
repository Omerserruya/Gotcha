import { describe, expect, it } from 'vitest';

import {
  isEditable,
  isSubmittable,
  platformSenderSchema,
  platformTemplateListSchema,
  senderCanSend,
  type PlatformTemplate,
} from './platform-whatsapp';

/** Backend 582f50a4, docs/api/platform-whatsapp-contract.md: the shapes as sent. */
const status = {
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
  launch: { appId: 'a', configId: 'c', esVersion: 'v4', extras: {}, configured: true },
};

const language = (over: Record<string, unknown> = {}) => ({
  body: 'Hello {{1}}.',
  draftBody: null,
  status: 'NOT_SUBMITTED',
  rejectedReason: null,
  metaTemplateId: null,
  submittedAt: null,
  lastSyncedAt: null,
  ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  eventType: 'conversation.waiting',
  name: 'gotcha_customer_waiting',
  category: 'UTILITY',
  parameterCount: 2,
  buttons: { url: true, quickReplies: 0, copyCode: false },
  alertEnabled: false,
  toggleable: true,
  editable: true,
  canEnable: false,
  languages: { he: language(), en: language() },
  ...over,
});
const one = (over: Record<string, unknown> = {}): PlatformTemplate =>
  platformTemplateListSchema.parse([view(over)])[0]!;

describe('★★ the alerts number, read', () => {
  it('★★ the contract’s status parses whole, launch included', () => {
    const parsed = platformSenderSchema.parse(status);
    expect(parsed.status).toBe('CONNECTED');
    expect(parsed.number?.display).toBe('+972 50 000 0000');
    expect(parsed.launch?.configured).toBe(true);
  });

  it('★★ a state this build has no name for is UNKNOWN, never a failed read', () => {
    expect(platformSenderSchema.parse({ ...status, status: 'MIGRATING' }).status).toBe('UNKNOWN');
    expect(
      one({ languages: { he: language({ status: 'LIMIT_EXCEEDED' }), en: language() } }).languages
        .he?.status,
    ).toBe('UNKNOWN');
  });

  it('★ nothing ever connected: number null, the display may be null too', () => {
    expect(
      platformSenderSchema.parse({ ...status, status: 'DISCONNECTED', number: null }).number,
    ).toBeNull();
    expect(
      platformSenderSchema.parse({ ...status, number: { ...status.number, display: null } }).number
        ?.display,
    ).toBeNull();
  });

  it('★★ only CONNECTED and PENDING_WEBHOOK send', () => {
    expect(senderCanSend('CONNECTED')).toBe(true);
    expect(senderCanSend('PENDING_WEBHOOK')).toBe(true);
    expect(senderCanSend('TOKEN_INVALID')).toBe(false);
    expect(senderCanSend('DISCONNECTED')).toBe(false);
    expect(senderCanSend('UNKNOWN')).toBe(false);
  });
});

describe('★★ a template, edited and sent', () => {
  it('★★ never a body Meta writes (editable: false), whatever its state', () => {
    const verification = one({
      name: 'gotcha_verification_code',
      category: 'AUTHENTICATION',
      editable: false,
    });
    expect(isEditable(verification, 'NOT_SUBMITTED')).toBe(false);
    expect(isEditable(verification, 'REJECTED')).toBe(false);
  });

  it('★★ never while Meta reviews or deletes it', () => {
    const template = one();
    for (const s of ['PENDING', 'IN_APPEAL', 'PENDING_DELETION', 'DISABLED', 'UNKNOWN'] as const) {
      expect(isEditable(template, s), s).toBe(false);
    }
    for (const s of ['NOT_SUBMITTED', 'REJECTED', 'PAUSED', 'APPROVED'] as const) {
      expect(isEditable(template, s), s).toBe(true);
    }
  });

  it('★★ sent when there is something new for Meta: a draft, or never sent, sent back, paused', () => {
    const row = (over: Record<string, unknown>) =>
      one({ languages: { he: language(over), en: language() } }).languages.he!;
    expect(isSubmittable(row({ status: 'NOT_SUBMITTED' }))).toBe(true);
    expect(isSubmittable(row({ status: 'REJECTED' }))).toBe(true);
    expect(isSubmittable(row({ status: 'PAUSED' }))).toBe(true);
    expect(isSubmittable(row({ status: 'APPROVED', draftBody: 'New {{1}} text {{2}}.' }))).toBe(
      true,
    );
    expect(isSubmittable(row({ status: 'APPROVED' }))).toBe(false);
    expect(isSubmittable(row({ status: 'PENDING' }))).toBe(false);
  });

  it('★ the route’s canEnable and editable are read, not defaulted true', () => {
    const parsed = one({ canEnable: true });
    expect(parsed.canEnable).toBe(true);
    expect(one({ canEnable: undefined, editable: undefined }).canEnable).toBe(false);
    expect(one({ editable: undefined }).editable).toBe(false);
  });
});
