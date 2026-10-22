import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client/browser-api', () => ({ browserApi: { post: vi.fn() } }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { fileProblem, IMAGE_SLOTS } = await import('./widget-image');

afterEach(() => {
  vi.unstubAllGlobals();
});

const png = (bytes = 10) => new File([new Uint8Array(bytes)], 'a.png', { type: 'image/png' });
const sized = (width: number, height: number) =>
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width, height, close: () => undefined }),
  );

describe('★★ W3 - an image checked against its slot before anything is sent', () => {
  it('the limits are the layout’s: logo 1 MB, 1024²; cover 3 MB, 2400×1600', () => {
    expect(IMAGE_SLOTS).toEqual({
      logo: { maxBytes: 1_000_000, maxWidth: 1024, maxHeight: 1024 },
      cover: { maxBytes: 3_000_000, maxWidth: 2400, maxHeight: 1600 },
    });
  });

  it('★ the pixel size, where the browser can read it: over is refused, with both sizes', async () => {
    sized(1200, 800);
    expect(await fileProblem('logo', png())).toEqual({
      reason: 'too_big',
      maxWidth: 1024,
      maxHeight: 1024,
      width: 1200,
      height: 800,
    });
    // The cover takes it.
    expect(await fileProblem('cover', png())).toBeNull();
  });

  it('a browser that cannot read it: left to the server, never refused on a guess', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('no')));
    expect(await fileProblem('logo', png())).toBeNull();
  });

  it('exactly at the limit passes; one byte over does not', async () => {
    sized(10, 10);
    expect(await fileProblem('logo', png(1_000_000))).toBeNull();
    expect(await fileProblem('logo', png(1_000_001))).toMatchObject({ reason: 'too_large' });
  });
});
