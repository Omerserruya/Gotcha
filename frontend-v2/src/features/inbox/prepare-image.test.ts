import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fitWithin,
  imagePlan,
  isJpeg,
  isStaticWebp,
  jpegName,
  MAX_IMAGE_SIDE,
  prepareImage,
} from './prepare-image';

/** The decision before an image goes to Meta (prod 131053, 2026-11-15). */
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 0, 0, 0]);
const PNG = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]);
const webp = (chunk: string, flags = 0) =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], [flags, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]);

describe('★★ imagePlan: re-encode what Meta may refuse, and nothing else', () => {
  it.each(['WHATSAPP', 'INSTAGRAM', 'MESSENGER'])('★★ %s: a PNG is re-encoded', (channel) => {
    expect(imagePlan({ type: 'image/png' }, PNG, channel)).toBe('reencode');
  });

  it.each([
    ['image/heic', PNG],
    ['image/heif', PNG],
    ['image/gif', bytes('GIF89a')],
    ['image/webp', webp('VP8X', 0x02)],
    ['image/webp', bytes('RIFF')],
  ])('★ WhatsApp: %s is re-encoded', (type, header) => {
    expect(imagePlan({ type }, header, 'WHATSAPP')).toBe('reencode');
  });

  it('★★ a JPEG goes as it is - by its bytes, whatever the type says', () => {
    expect(imagePlan({ type: 'image/jpeg' }, JPEG, 'WHATSAPP')).toBe('send-as-is');
    expect(imagePlan({ type: 'image/png' }, JPEG, 'WHATSAPP')).toBe('send-as-is');
  });

  it('★ a "JPEG" that is not one by its bytes is re-encoded', () => {
    expect(imagePlan({ type: 'image/jpeg' }, PNG, 'WHATSAPP')).toBe('reencode');
  });

  it.each([webp('VP8 '), webp('VP8L'), webp('VP8X', 0x00), webp('VP8X', 0x10)])(
    '★ a static WebP goes as it is',
    (header) => {
      expect(imagePlan({ type: 'image/webp' }, header, 'WHATSAPP')).toBe('send-as-is');
    },
  );

  it.each([['EMAIL'], ['WEBCHAT'], ['GMAIL'], [null]])(
    "★★ %s: never touched - a logo's transparency is not ours to change",
    (channel) => {
      expect(imagePlan({ type: 'image/png' }, PNG, channel)).toBe('send-as-is');
    },
  );

  it('★ not an image: as chosen', () => {
    expect(imagePlan({ type: 'application/pdf' }, PNG, 'WHATSAPP')).toBe('send-as-is');
    expect(imagePlan({ type: 'video/mp4' }, PNG, 'WHATSAPP')).toBe('send-as-is');
  });
});

describe('★ the pieces', () => {
  it('reads the bytes', () => {
    expect(isJpeg(JPEG)).toBe(true);
    expect(isJpeg(PNG)).toBe(false);
    expect(isStaticWebp(webp('VP8X', 0x02))).toBe(false);
    expect(isStaticWebp(webp('VP8X', 0x00))).toBe(true);
    expect(isStaticWebp(bytes('RIFF'))).toBe(false);
  });

  it('caps the long side and never enlarges', () => {
    expect(fitWithin(5120, 2880)).toEqual({ width: MAX_IMAGE_SIDE, height: 1440 });
    expect(fitWithin(1170, 2532)).toEqual({ width: 1170, height: 2532 });
    expect(fitWithin(1290, 5000)).toEqual({ width: 660, height: MAX_IMAGE_SIDE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('names the JPEG', () => {
    expect(jpegName('IMG_4538.png')).toBe('IMG_4538.jpg');
    expect(jpegName('photo.HEIC')).toBe('photo.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
    expect(jpegName('.png')).toBe('image.jpg');
  });
});

describe('★★ prepareImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  const draw = vi.fn();
  const fillRect = vi.fn();
  const stubCanvas = (blob: Blob | null) => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ fillStyle: '', fillRect, drawImage: draw })),
      toBlob: (done: (b: Blob | null) => void, type: string, quality: number) => {
        canvas.encoded = { type, quality };
        done(blob);
      },
      encoded: null as null | { type: string; quality: number },
    };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(canvas as never);
    return canvas;
  };

  it('★★ an iPhone PNG to WhatsApp goes as an sRGB JPEG, long side capped, white under alpha', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 5120, height: 2880, close: vi.fn() })),
    );
    const canvas = stubCanvas(new Blob(['jpeg'], { type: 'image/jpeg' }));
    const png = new File([PNG], 'IMG_4538.png', { type: 'image/png' });
    const out = await prepareImage(png, 'WHATSAPP');
    expect(out.name).toBe('IMG_4538.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(canvas.encoded).toEqual({ type: 'image/jpeg', quality: 0.9 });
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { colorSpace: 'srgb' });
    expect([canvas.width, canvas.height]).toEqual([2560, 1440]);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 2560, 1440);
  });

  it('★★ a browser that cannot decode it (HEIC on Chrome) sends the original - as before', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => Promise.reject(new Error('decode'))),
    );
    const heic = new File([PNG], 'photo.heic', { type: 'image/heic' });
    expect(await prepareImage(heic, 'WHATSAPP')).toBe(heic);
  });

  it('★ an encoder that returns nothing sends the original', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })),
    );
    stubCanvas(null);
    const png = new File([PNG], 'a.png', { type: 'image/png' });
    expect(await prepareImage(png, 'WHATSAPP')).toBe(png);
  });

  it('★ a JPEG is not decoded at all', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const jpeg = new File([JPEG], 'a.jpg', { type: 'image/jpeg' });
    expect(await prepareImage(jpeg, 'WHATSAPP')).toBe(jpeg);
    expect(decode).not.toHaveBeenCalled();
  });
});
