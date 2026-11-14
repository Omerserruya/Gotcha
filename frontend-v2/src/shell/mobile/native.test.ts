import { afterEach, describe, expect, it } from 'vitest';

import { documentPlugin } from './native';

type W = { Capacitor?: unknown };
const set = (plugins: Record<string, unknown>) => {
  (window as unknown as W).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugins,
  };
};

afterEach(() => {
  delete (window as unknown as W).Capacitor;
});

describe('documentPlugin', () => {
  it("★ the app's viewer when its plugin has openDocument", () => {
    const openDocument = async () => ({ opened: true });
    set({ NavigationPolicy: { openDocument } });
    expect(documentPlugin()?.openDocument).toBe(openDocument);
  });
  it('an older app (the plugin without it), or a browser: none, so the browser is used', () => {
    set({ NavigationPolicy: {} });
    expect(documentPlugin()).toBeNull();
    delete (window as unknown as W).Capacitor;
    expect(documentPlugin()).toBeNull();
  });
});
