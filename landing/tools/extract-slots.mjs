import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');

const OUT = path.join(ROOT, 'public/assets/slots');

const state = JSON.parse(fs.readFileSync(path.join(DESIGN, 'image-slots.state.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const manifest = {};
for (const [id, v] of Object.entries(state)) {
  if (!v || typeof v !== 'object' || typeof v.u !== 'string') continue;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(v.u);
  if (!m) { console.log(`${id}: not a data URI (${v.u.slice(0, 40)})`); continue; }
  const ext = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[m[1]] || 'bin';
  const file = `${id}.${ext}`;
  const buf = Buffer.from(m[2], 'base64');
  fs.writeFileSync(path.join(OUT, file), buf);
  manifest[id] = { src: `/assets/slots/${file}`, scale: v.s ?? 1, x: v.x ?? 0, y: v.y ?? 0 };
  console.log(`${id.padEnd(18)} -> ${file.padEnd(26)} ${(buf.length / 1024).toFixed(0)} KB   scale=${v.s?.toFixed(3)} x=${v.x?.toFixed(2)} y=${v.y?.toFixed(2)}`);
}

fs.writeFileSync(path.join(ROOT, 'src/generated/image-slots.json'), JSON.stringify(manifest, null, 2));
console.log('\nwrote manifest with', Object.keys(manifest).length, 'slots');
