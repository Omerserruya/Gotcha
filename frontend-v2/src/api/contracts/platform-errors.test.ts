import { describe, expect, it } from 'vitest';

import { platformErrorReason, stripErrorCode, voiceErrorReason } from './platform-errors';

describe('★★ a connection’s last error as a reason - code first, then the prefix, then the old sentence', () => {
  it('lastErrorCode wins', () => {
    expect(platformErrorReason('anything at all', 'SHOPIFY_CHAT_UNINSTALLED')).toBe(
      'shopify_chat_uninstalled',
    );
    expect(platformErrorReason('x', 'SHOPIFY_APP_UNINSTALLED')).toBe('shopify_app_uninstalled');
  });

  it('a "[CODE] " still on the sentence (a service not yet rebuilt) is read, and stripped', () => {
    const raw = '[SHOPIFY_CHAT_UNINSTALLED] Shopify Chat app was uninstalled from the store.';
    expect(platformErrorReason(raw, null)).toBe('shopify_chat_uninstalled');
    expect(stripErrorCode(raw)).toBe('Shopify Chat app was uninstalled from the store.');
    // The prefix's code is what is read - not the sentence, which may be reworded.
    expect(platformErrorReason('[SHOPIFY_APP_UNINSTALLED] Reworded since.', null)).toBe(
      'shopify_app_uninstalled',
    );
  });

  it('old rows: the exact sentences each writer stored', () => {
    expect(platformErrorReason('Shopify Chat app was uninstalled from the store.')).toBe(
      'shopify_chat_uninstalled',
    );
    expect(platformErrorReason('The GOTCHA Shopify app was uninstalled from this store.')).toBe(
      'shopify_app_uninstalled',
    );
  });

  it('anything else is unknown - an unknown code included; nothing at all is null', () => {
    expect(platformErrorReason('No payment method on the account.')).toBe('unknown');
    expect(platformErrorReason('[SOMETHING_NEW] words', null)).toBe('unknown');
    expect(platformErrorReason('words', 'SOMETHING_NEW')).toBe('unknown');
    expect(platformErrorReason(null, null)).toBeNull();
    expect(platformErrorReason('  ', undefined)).toBeNull();
    expect(stripErrorCode('[X] ')).toBeNull();
  });
});

describe('★★ voice’s health as a reason - healthStatus first, then the outbound flag', () => {
  it('each value /validate writes', () => {
    expect(voiceErrorReason('decryption_failed', false)).toBe('voice_credentials_unreadable');
    expect(voiceErrorReason('twilio_api_401: {"code":20003}', false)).toBe(
      'voice_credentials_rejected',
    );
    expect(voiceErrorReason('twilio_api_403: Forbidden', false)).toBe('voice_credentials_rejected');
    expect(voiceErrorReason('account_unreachable', false)).toBe('voice_twilio_unreachable');
    expect(voiceErrorReason('failed', false)).toBe('voice_twilio_unreachable');
  });

  it('any other health text is unknown - Twilio’s 500 body, a fetch error - never printed', () => {
    expect(voiceErrorReason('twilio_api_500: upstream', false)).toBe('unknown');
    expect(voiceErrorReason('fetch failed', true)).toBe('unknown');
  });

  it('healthy, or never checked: the outbound flag decides', () => {
    expect(voiceErrorReason('ok', true)).toBe('voice_outbound_not_set_up');
    expect(voiceErrorReason(null, true)).toBe('voice_outbound_not_set_up');
    expect(voiceErrorReason('ok', false)).toBeNull();
    expect(voiceErrorReason(undefined, false)).toBeNull();
    expect(voiceErrorReason('  ', false)).toBeNull();
  });

  it('a failed check outranks the outbound flag', () => {
    expect(voiceErrorReason('decryption_failed', true)).toBe('voice_credentials_unreadable');
  });
});
