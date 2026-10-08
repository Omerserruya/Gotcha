import { describe, expect, it } from 'vitest';

import { platformErrorReason, stripErrorCode } from './platform-errors';

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
