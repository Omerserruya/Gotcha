/**
 * Builds the tab icons from the design's own logo mark.
 *
 * ONE icon decides the colour, and it is the SVG.
 *
 * The obvious arrangement - a black PNG at `media="(prefers-color-scheme:
 * light)"` and a white one at `dark` - is correct markup that Chrome does not
 * implement: it ignores the `media` attribute on a favicon link entirely, then
 * picks by size and type. So a dark-mode visitor got whichever file Chrome
 * happened to prefer, which was the black one, on a dark tab strip. Firefox and
 * Safari honoured the query and looked right, which is what made it read as a
 * cache problem rather than a browser difference.
 *
 * An SVG favicon carries both colourways INSIDE the file, as a `@media` rule on
 * a fill, so the browser never has to choose between two files. Chrome, Firefox
 * and Safari 15+ all support that, and all three prefer an SVG icon when one is
 * offered. The .ico stays as the fallback for anything older, in the mark's
 * dark colourway, because a fallback cannot know the theme and a tab strip is
 * light far more often than not.
 *
 * The mark is a flat silhouette - measured: one RGB value over an alpha channel
 * - so the SVG carries the alpha as a mask and fills it with a colour, rather
 * than embedding two bitmaps and hiding one. One image, one fill rule, and the
 * anti-aliased edges survive intact.
 *
 * No image library: there is none in this repo and adding one for a resize is
 * not worth a dependency. PNG is a filter byte per row over zlib, and a box
 * filter is an average - both are short enough to write.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design', 'logo');
const OUT = join(ROOT, 'public', 'assets');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG into flat RGBA. Handles the colour types the design exports. */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (!(colour in CHANNELS)) throw new Error(`unsupported colour type ${colour}`);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }

  const ch = CHANNELS[colour];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }

    for (let x = 0; x < width; x++) {
      const s = x * ch;
      const d = (y * width + x) * 4;
      if (ch >= 3) {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = ch === 4 ? line[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = ch === 2 ? line[s + 1] : 255;
      }
    }
    prev = line;
  }

  return { width, height, rgba: out };
}

/** Box-filter downsample, averaging in premultiplied alpha so edges stay clean. */
function resize(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const sx = img.width / size;
  const sy = img.height / size;

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;

      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.width + xx) * 4;
          const al = img.rgba[s + 3] / 255;
          r += img.rgba[s] * al;
          g += img.rgba[s + 1] * al;
          b += img.rgba[s + 2] * al;
          a += img.rgba[s + 3];
          n++;
        }
      }

      const d = (y * size + x) * 4;
      const alpha = a / n;
      const scale = alpha > 0 ? 255 / alpha : 0;
      out[d] = Math.min(255, Math.round((r / n) * scale));
      out[d + 1] = Math.min(255, Math.round((g / n) * scale));
      out[d + 2] = Math.min(255, Math.round((b / n) * scale));
      out[d + 3] = Math.round(alpha);
    }
  }
  return { width: size, height: size, rgba: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(img) {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none, the rows are tiny
    img.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An ICO wrapping PNG frames.
 *
 * The .ico is the icon every browser understands and the one several of them
 * reach for regardless of the `media` on the PNG links, so it cannot be left
 * as whatever shipped before - it decides what most tabs actually show. PNG
 * frames inside an ICO have been read correctly since IE11, so the frames are
 * the same encoder as above rather than a second BMP path.
 */
function encodeIco(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  let offset = header.length;
  for (const [i, f] of frames.entries()) {
    const e = 6 + 16 * i;
    header[e] = f.size >= 256 ? 0 : f.size; // 0 means 256
    header[e + 1] = f.size >= 256 ? 0 : f.size;
    header[e + 2] = 0; // palette size: none, it is truecolour
    header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(f.bytes.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += f.bytes.length;
  }

  return Buffer.concat([header, ...frames.map((f) => f.bytes)]);
}

/**
 * Turn the mark's alpha channel into an opaque greyscale image.
 *
 * An SVG `<mask>` is a luminance mask by default, so a pixel's contribution is
 * its brightness times its alpha. Feeding it the mark directly would work only
 * because that mark happens to be white; the black one would mask everything
 * away. Moving alpha into the colour channels and making the image opaque says
 * what is meant - this is coverage, not a picture - and works from either
 * colourway.
 */
function alphaToLuminance(img) {
  const out = Buffer.alloc(img.rgba.length);
  for (let i = 0; i < img.rgba.length; i += 4) {
    const a = img.rgba[i + 3];
    out[i] = out[i + 1] = out[i + 2] = a;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, rgba: out };
}

/** Composite over an opaque ground, for the icons that may not be transparent. */
function flatten(img, [r, g, b]) {
  const out = Buffer.alloc(img.rgba.length);
  for (let i = 0; i < img.rgba.length; i += 4) {
    const a = img.rgba[i + 3] / 255;
    out[i] = Math.round(img.rgba[i] * a + r * (1 - a));
    out[i + 1] = Math.round(img.rgba[i + 1] * a + g * (1 - a));
    out[i + 2] = Math.round(img.rgba[i + 2] * a + b * (1 - a));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, rgba: out };
}

/** The design's ink and its page ground. Both appear in "GOTCHA Landing.dc.html". */
const INK = '#16150F';
const PAPER = [0xfa, 0xf8, 0xf4];

const mark = decodePng(readFileSync(join(SRC, 'solid-icon-dark.png')));

// ── favicon.svg - the one that decides the colour ────────────────────────────
//
// 128px of coverage data: an SVG favicon is drawn at 16 to 64px in practice, and
// past 128 the extra bytes buy nothing a tab will ever show. The mask is the
// mark's own alpha, so the shape is exact rather than traced.
{
  const coverage = encodePng(alphaToLuminance(resize(mark, 128)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <title>GOTCHA</title>
  <style>
    .mark { fill: ${INK} }
    @media (prefers-color-scheme: dark) { .mark { fill: #FFFFFF } }
  </style>
  <mask id="m">
    <image width="128" height="128" href="data:image/png;base64,${coverage.toString('base64')}"/>
  </mask>
  <rect class="mark" width="128" height="128" mask="url(#m)"/>
</svg>
`;
  writeFileSync(join(OUT, 'favicon.svg'), svg);
  console.log(`solid-icon-dark.png -> favicon.svg   128px mask, ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);
}

// ── favicon.ico - the fallback, for anything that cannot read the SVG ────────
//
// The dark colourway: a fallback is not told which theme the tab strip is in,
// and a light strip is the common case.
{
  const frames = [16, 32, 48].map((size) => ({ size, bytes: encodePng(resize(mark, size)) }));
  const ico = encodeIco(frames);
  writeFileSync(join(OUT, 'favicon.ico'), ico);
  console.log(`solid-icon-dark.png -> favicon.ico   ${frames.map((f) => f.size).join('/')}px, ${(ico.length / 1024).toFixed(1)} KB`);
}

// ── apple-touch-icon.png - flattened onto the brand ground ───────────────────
//
// iOS does not honour transparency here: it composites a home-screen icon onto
// an opaque tile, historically black. A black mark on transparent therefore
// arrives as a black mark on black. On the design's paper it is the logo.
{
  const bytes = encodePng(flatten(resize(mark, 180), PAPER));
  writeFileSync(join(OUT, 'apple-touch-icon.png'), bytes);
  console.log(`solid-icon-dark.png -> apple-touch-icon.png  180px on paper, ${(bytes.length / 1024).toFixed(1)} KB`);
}
