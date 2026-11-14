import { describe, expect, it } from 'vitest';

import { outsideUrl, signedFileOf } from './link-policy';

const here = new URL('https://dev.gotcha.co.il/he/m/inbox/c1');
const link = (href: string, inApp = false) => {
  const a = document.createElement('a');
  a.href = href;
  if (inApp) a.setAttribute('data-in-app', '');
  return a;
};

describe('outsideUrl', () => {
  // Omer, 2026-11-04: a photo opened in the app AND in the browser.
  it('★ a link marked data-in-app stays in the app, whatever its address', () => {
    expect(outsideUrl(link('https://dev.gotcha.co.il/api/bff/x.jpg', true), here)).toBeNull();
    expect(outsideUrl(link('https://cdn.example.com/x.jpg', true), here)).toBeNull();
  });
  it('the same photo link unmarked still goes to the browser', () => {
    expect(outsideUrl(link('https://dev.gotcha.co.il/api/bff/x.jpg'), here)).toBe(
      'https://dev.gotcha.co.il/api/bff/x.jpg',
    );
  });
  it("the app's own screens and sign-in stay; other sites go out", () => {
    expect(outsideUrl(link('https://dev.gotcha.co.il/he/m/customers'), here)).toBeNull();
    expect(outsideUrl(link('https://dev.gotcha.co.il/api/auth/sign-in'), here)).toBeNull();
    expect(outsideUrl(link('https://example.com/p'), here)).toBe('https://example.com/p');
    expect(outsideUrl(link('tel:+972500000000'), here)).toBeNull();
  });
});

describe('signedFileOf', () => {
  // Omer, 2026-11-04: a PDF in the app opened the browser with no login: 401.
  it('★ a marked document link names its conversation and message', () => {
    const a = link('https://dev.gotcha.co.il/api/conversations/c1/messages/m1/media/x.pdf');
    a.setAttribute('data-signed-file', '');
    expect(signedFileOf(a)).toEqual({ conversationId: 'c1', messageId: 'm1' });
  });
  it('unmarked, or not a stored file, is none', () => {
    expect(
      signedFileOf(link('https://dev.gotcha.co.il/api/conversations/c1/messages/m1/media/x.pdf')),
    ).toBeNull();
    const cdn = link('https://scontent.xx.fbcdn.net/v/abc.pdf');
    cdn.setAttribute('data-signed-file', '');
    expect(signedFileOf(cdn)).toBeNull();
  });
});
