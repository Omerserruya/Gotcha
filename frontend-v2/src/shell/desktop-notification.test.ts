import { describe, expect, it, vi } from 'vitest';

import { conversationNotifier } from './desktop-notification';

/** A Notification that records itself, never a real one. */
function fakeNotification() {
  const made: FakeNotification[] = [];
  class FakeNotification {
    onclick: ((event: Event) => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn(() => this.onclose?.());
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      made.push(this);
    }
  }
  return { Notification: FakeNotification as unknown as typeof Notification, made };
}

const notice = (over = {}) => ({
  conversationId: 'c1',
  title: 'Dana Levi',
  body: 'Hi, where is my order?',
  icon: 'data:image/png;base64,AAAA',
  silent: true,
  lang: 'he',
  ...over,
});

describe('★ the desktop notification', () => {
  it('★ the name, the first line, the channel icon, and one tag per conversation', () => {
    const fake = fakeNotification();
    const show = conversationNotifier({
      Notification: fake.Notification,
      focus: vi.fn(),
      navigate: vi.fn(),
    });
    show(notice());
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]!.title).toBe('Dana Levi');
    expect(fake.made[0]!.options).toMatchObject({
      body: 'Hi, where is my order?',
      icon: 'data:image/png;base64,AAAA',
      tag: 'conv:c1',
      silent: true,
      lang: 'he',
    });
  });

  it('★ a second message from the same conversation replaces the first, never stacks', () => {
    const fake = fakeNotification();
    const show = conversationNotifier({
      Notification: fake.Notification,
      focus: vi.fn(),
      navigate: vi.fn(),
    });
    show(notice());
    show(notice({ body: 'Hello?' }));
    expect(fake.made[0]!.close).toHaveBeenCalledTimes(1);
    expect(fake.made[1]!.options.tag).toBe('conv:c1');
    // Another conversation is its own.
    show(notice({ conversationId: 'c2' }));
    expect(fake.made[1]!.close).not.toHaveBeenCalled();
    expect(fake.made[2]!.options.tag).toBe('conv:c2');
  });

  it('★ a click brings the tab forward and opens that conversation in the inbox', () => {
    const fake = fakeNotification();
    const focus = vi.fn();
    const navigate = vi.fn();
    const show = conversationNotifier({ Notification: fake.Notification, focus, navigate });
    show(notice({ conversationId: 'conv 7' }));
    const click = new Event('click', { cancelable: true });
    fake.made[0]!.onclick!(click);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/inbox?c=conv%207');
    expect(fake.made[0]!.close).toHaveBeenCalled();
  });

  it('a platform that refuses `new Notification` (Chrome on Android): nothing, no error', () => {
    const Throwing = vi.fn(function () {
      throw new TypeError('Illegal constructor');
    }) as unknown as typeof Notification;
    const show = conversationNotifier({
      Notification: Throwing,
      focus: vi.fn(),
      navigate: vi.fn(),
    });
    expect(show(notice())).toBeNull();
  });

  it('no Notification in this browser: nothing', () => {
    const show = conversationNotifier({
      Notification: undefined,
      focus: vi.fn(),
      navigate: vi.fn(),
    });
    expect(show(notice())).toBeNull();
  });
});
