import { describe, expect, it } from 'vitest';

import { capabilitiesOf, supports, type ChannelId } from './channel';

const ALL_CHANNELS: readonly ChannelId[] = ['whatsapp', 'instagram', 'email', 'web_chat', 'voice'];

describe('channel capabilities', () => {
  it('answers for every channel, so a new one cannot be silently unhandled', () => {
    for (const channel of ALL_CHANNELS) {
      expect(capabilitiesOf(channel)).toBeDefined();
    }
  });

  it('models the reply window that only some channels impose', () => {
    expect(supports('whatsapp', 'hasReplyWindow')).toBe(true);
    expect(supports('email', 'hasReplyWindow')).toBe(false);
  });

  it('defaults every capability to false rather than assuming support', () => {
    // A capability wrongly true produces a control that fails on click; wrongly
    // false produces one that is merely absent. The default must be the latter.
    expect(supports('web_chat', 'canEditSentMessage')).toBe(false);
    expect(supports('web_chat', 'canReact')).toBe(false);
    expect(supports('voice', 'canSendAttachments')).toBe(false);
  });

  it('lets a component ask what a channel can do, not which channel it is', () => {
    const canThread = ALL_CHANNELS.filter((c) => supports(c, 'canReplyToSpecificMessage'));
    expect(canThread).toContain('whatsapp');
    expect(canThread).not.toContain('voice');
  });
});
