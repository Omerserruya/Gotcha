import { describe, expect, it } from 'vitest';

import { threadAiControl } from './thread-verbs';

const base = { resolved: false, handedOver: false, hasAiEmployee: true };

describe('threadAiControl', () => {
  it('★ handed to a person with an AI employee: one "back to AI" button, no pause', () => {
    expect(threadAiControl({ ...base, handedOver: true })).toEqual({ returnToAi: true, pauseInMenu: false });
  });

  it('★ the AI is on it: nothing in the bar, pause in the menu', () => {
    expect(threadAiControl(base)).toEqual({ returnToAi: false, pauseInMenu: true });
  });

  it('resolved: nothing about the AI, handed over or not', () => {
    const none = { returnToAi: false, pauseInMenu: false };
    expect(threadAiControl({ ...base, resolved: true })).toEqual(none);
    expect(threadAiControl({ ...base, resolved: true, handedOver: true })).toEqual(none);
  });

  it('no AI employee: nobody to hand back to, nothing to pause', () => {
    const none = { returnToAi: false, pauseInMenu: false };
    expect(threadAiControl({ ...base, hasAiEmployee: false, handedOver: true })).toEqual(none);
    expect(threadAiControl({ ...base, hasAiEmployee: false })).toEqual(none);
  });
});
