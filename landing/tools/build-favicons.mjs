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
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/** The design's own palette, all three from "GOTCHA Landing.dc.html". */
const INK = [0x16, 0x15, 0x0f];
const ACCENT = [0xc4, 0x55, 0x2f];
const PAPER = [0xfa, 0xf8, 0xf4];
const hex = ([r, g, b]) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

/**
 * Paint the mark in one colour on a rounded tile of another.
 *
 * `inset` is the breathing room around the mark, as a fraction of the tile: the
 * design's mark fills its own frame edge to edge, which is right on a page and
 * cramped inside a tile.
 */
function tile(markImg, size, ground, ink, inset = 0.17, radius = 0.22) {
  const out = Buffer.alloc(size * size * 4);
  const pad = Math.round(size * inset);
  const inner = Math.max(1, size - pad * 2);
  const m = resize(markImg, inner);
  const r = size * radius;

  // Coverage of a rounded square, sampled at the pixel centre.
  const insideTile = (x, y) => {
    if (r <= 0) return true;
    const cx = Math.min(Math.max(x + 0.5, r), size - r);
    const cy = Math.min(Math.max(y + 0.5, r), size - r);
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (y * size + x) * 4;
      if (!insideTile(x, y)) { out[d + 3] = 0; continue; }

      let a = 0;
      const mx = x - pad;
      const my = y - pad;
      if (mx >= 0 && my >= 0 && mx < inner && my < inner) a = m.rgba[(my * inner + mx) * 4 + 3] / 255;

      out[d] = Math.round(ink[0] * a + ground[0] * (1 - a));
      out[d + 1] = Math.round(ink[1] * a + ground[1] * (1 - a));
      out[d + 2] = Math.round(ink[2] * a + ground[2] * (1 - a));
      out[d + 3] = 255;
    }
  }
  return { width: size, height: size, rgba: out };
}

const mark = decodePng(readFileSync(join(SRC, 'solid-icon-dark.png')));

/*
 * Why a tile, and not the mark on its own.
 *
 * The mark is a silhouette, so on its own it needs the tab strip to be the
 * opposite colour, and only the browser knows which that is. The obvious answer
 * - one SVG carrying both colourways behind `prefers-color-scheme` - is what
 * shipped, and it is right everywhere except the one place it had to be right:
 * Chromium rasterises a favicon through a restricted path that does not apply
 * the browser's colour scheme, so it takes the light branch and draws the ink
 * mark onto a dark tab strip. Firefox and Safari honour the query, which is
 * what made it look fixed here. Chromium honours it for an <img> too, so even
 * testing it that way agreed - and the tab was still black.
 *
 * An opaque tile asks the browser nothing. In the accent rather than the ink,
 * because a dark tile on a dark strip is the same complaint again.
 */
/**
 * The sizes a browser actually asks for.
 *
 * 16 and 32 are the tab and the bookmark bar; 48 is what Windows shortcuts and
 * some readers pick up; 96 covers a 2x 48 and a desktop shortcut. Each is drawn
 * from the full-resolution mark rather than scaled from one another, so the
 * 16px tile keeps its corner radius instead of smearing it.
 */
const SIZES = [16, 32, 48, 96];

// ── favicon-<n>.png - the icons the pages declare ────────────────────────────
{
  for (const size of SIZES) {
    const bytes = encodePng(tile(mark, size, ACCENT, [255, 255, 255]));
    writeFileSync(join(OUT, `favicon-${size}.png`), bytes);
    console.log(`favicon-${size}.png`.padEnd(22) + `${size}px tile, ${bytes.length} B`);
  }
}

// ── favicon.ico - not declared, but still fetched ────────────────────────────
//
// A browser with no icon in the markup asks for /favicon.ico, and so do
// crawlers, feed readers and link unfurlers that never parse the page. It costs
// two kilobytes to answer them with the right picture rather than a 404.
{
  const frames = [16, 32, 48].map((size) => ({ size, bytes: encodePng(tile(mark, size, ACCENT, [255, 255, 255])) }));
  const ico = encodeIco(frames);
  writeFileSync(join(OUT, 'favicon.ico'), ico);
  console.log(`favicon.ico`.padEnd(22) + `16/32/48px tile, ${(ico.length / 1024).toFixed(1)} KB`);
}

// ── apple-touch-icon.png ─────────────────────────────────────────────────────
//
// iOS rounds the corners itself and composites onto an opaque tile, so this one
// is square and edge to edge.
{
  const bytes = encodePng(tile(mark, 180, ACCENT, [255, 255, 255], 0.17, 0));
  writeFileSync(join(OUT, 'apple-touch-icon.png'), bytes);
  console.log(`apple-touch-icon.png  180px tile, ${(bytes.length / 1024).toFixed(1)} KB`);
}

/*
 * One copy of each file, and a version in its URL.
 *
 * The application host serves the same icons, and they were kept in step by
 * hand - which is exactly the kind of step that gets forgotten. The script that
 * makes them puts them in both places.
 *
 * The version matters more. Cloudflare caches /assets/* at the edge for four
 * hours, so the first tile deploy went out with the origin correct and the edge
 * still handing every visitor the previous icon: cf-cache-status HIT, age 1128.
 * Three rounds of "it still looks the same" are partly that. A content hash in
 * the query string changes the cache key the moment the bytes change, so an
 * icon fix is visible as soon as it ships rather than up to four hours later.
 */
const APP = join(ROOT, '..', 'frontend', 'public');
const SHARED = [...SIZES.map((n) => `favicon-${n}.png`), 'favicon.ico', 'apple-touch-icon.png'];
for (const f of SHARED) copyFileSync(join(OUT, f), join(APP, f));

const stamp = createHash('sha256')
  .update(Buffer.concat(SHARED.map((f) => readFileSync(join(OUT, f)))))
  .digest('hex')
  .slice(0, 8);

const module = `/* GENERATED by tools/build-favicons.mjs - do not edit. */

/**
 * Content hash of the tab icons, for the query string on their URLs.
 *
 * Cloudflare caches them at the edge for four hours and keys on the full URL,
 * so without this a new icon reaches the origin and not the visitor.
 */
export const ICON_VERSION = '${stamp}';
`;
for (const dir of [join(ROOT, 'src', 'generated'), join(ROOT, '..', 'frontend', 'src', 'generated')]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'icon-version.ts'), module);
}
console.log(`copied to frontend/public and stamped v=${stamp}`);
