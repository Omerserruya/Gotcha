import { describe, expect, it } from 'vitest';

import { openPhoneConversation, wantsBanner } from './inbound-banner';

const visible = (assignedAgentId: string | null) => ({
  access: 'visible' as const,
  assignedAgentId,
});
const base = { direction: 'INBOUND' as const, conversationId: 'c1', openId: null, meId: 'me' };

describe('wantsBanner', () => {
  it("★ a customer message in a conversation that is nobody's, or mine", () => {
    expect(wantsBanner({ ...base, glance: visible(null) })).toBe(true);
    expect(wantsBanner({ ...base, glance: visible('me') })).toBe(true);
  });
  it("★ not a colleague's conversation", () => {
    expect(wantsBanner({ ...base, glance: visible('someone') })).toBe(false);
    expect(wantsBanner({ ...base, meId: null, glance: visible('someone') })).toBe(false);
  });
  it('not our own side, not the open one, not one we cannot see', () => {
    expect(wantsBanner({ ...base, direction: 'OUTBOUND', glance: visible(null) })).toBe(false);
    expect(wantsBanner({ ...base, direction: null, glance: visible(null) })).toBe(false);
    expect(wantsBanner({ ...base, openId: 'c1', glance: visible(null) })).toBe(false);
    expect(wantsBanner({ ...base, glance: { access: 'refused', assignedAgentId: null } })).toBe(
      false,
    );
    expect(wantsBanner({ ...base, glance: { access: 'failed', assignedAgentId: null } })).toBe(
      false,
    );
  });
});

describe('openPhoneConversation', () => {
  it('reads the thread, not its customer screen or the list', () => {
    expect(openPhoneConversation('/he/m/inbox/c1')).toBe('c1');
    expect(openPhoneConversation('/m/inbox/c1/')).toBe('c1');
    expect(openPhoneConversation('/he/m/inbox')).toBeNull();
    expect(openPhoneConversation('/he/m/inbox/c1/customer')).toBeNull();
  });
});
