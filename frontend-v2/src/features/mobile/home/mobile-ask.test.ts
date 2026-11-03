import { describe, expect, it } from 'vitest';

import { newTurn } from '@/features/home/thread-turns';

import { approvalHref, canAsk, dockMode } from './mobile-ask';

const running = { ...newTurn('t1', 'How many refunds today?'), status: 'running' as const };

describe('the dock: Stop while an answer is written, Send otherwise', () => {
  it('★ Stop while running, "stopping" once pressed, Send when done or before any question', () => {
    expect(dockMode(undefined)).toBe('send');
    expect(dockMode(running)).toBe('stop');
    expect(dockMode({ ...running, cancelling: true })).toBe('stopping');
    for (const status of ['done', 'cancelled', 'failed'] as const) {
      expect(dockMode({ ...running, status })).toBe('send');
    }
  });
});

describe('★ a question goes only when it can be answered', () => {
  it('something to ask, nothing still being written, a thread that opened', () => {
    expect(canAsk('  ', undefined, 'idle')).toBe(false);
    expect(canAsk('How many?', undefined, 'idle')).toBe(true);
    // The route answers 409 to a second question while one is being answered.
    expect(canAsk('How many?', running, 'idle')).toBe(false);
    expect(canAsk('How many?', { ...running, status: 'done' }, 'idle')).toBe(true);
  });

  it('⚠ not while a thread opens, nor into one that could not be opened', () => {
    for (const opening of ['opening', 'missing', 'failed'] as const) {
      expect(canAsk('How many?', undefined, opening)).toBe(false);
    }
  });
});

describe('a decision is made in the phone’s Approvals, never the website’s', () => {
  it('its own request when named, the queue otherwise', () => {
    expect(approvalHref('a 1')).toBe('/m/approvals/a%201');
    expect(approvalHref(null)).toBe('/m/approvals');
  });
});
