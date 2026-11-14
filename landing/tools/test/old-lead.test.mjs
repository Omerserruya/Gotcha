/**
 * The older pages' lead cards show the v8 contact form's copy. old-lead.js holds
 * it as constants (the older design has none of these strings to translate),
 * so this holds the constants to the v8 design itself: if the design rewords
 * the contact form, this fails instead of the two drifting apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const oldLead = fs.readFileSync(path.join(ROOT, 'src/lib/old-lead.js'), 'utf8');
const v8 = fs.readFileSync(path.join(ROOT, 'design/home-v8/GOTCHA Website.dc.html'), 'utf8');
const tkVals = v8.slice(v8.indexOf('  tkVals() {'), v8.indexOf('\n  }\n', v8.indexOf('  tkVals() {')));
const heDict = fs.readFileSync(path.join(ROOT, 'design/home-v8/he.js'), 'utf8');

const block = (lang) => {
  const m = new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)\\n  \\}`).exec(oldLead);
  assert.ok(m, `LEAD_COPY.${lang} not found`);
  const get = (k) => {
    const r = new RegExp(`${k}: (['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(m[1]);
    assert.ok(r, `LEAD_COPY.${lang}.${k} not found`);
    return r[2];
  };
  return { fields: get('fields'), okTitle: get('okTitle'), okBody: get('okBody'), pick: get('pick') };
};

const en = block('en');
const he = block('he');

for (const [k, field] of [['fields', 'errText'], ['okTitle', 'okTitle'], ['okBody', 'okBody']]) {
  test(`${k} is tkVals().${field} in both languages`, () => {
    const line = new RegExp(`${field}: en \\? (['"])(.*?)\\1 : (['"])(.*?)\\3`).exec(tkVals);
    assert.ok(line, `tkVals has no ${field}: en ? ... : ...`);
    assert.equal(en[k], line[2]);
    assert.equal(he[k], line[4]);
  });
}

test('pick is T("Pick a time") and its he.js entry', () => {
  assert.match(tkVals, /pick: T\('Pick a time'\)/);
  assert.equal(en.pick, 'Pick a time');
  assert.ok(heDict.includes(`'Pick a time': '${he.pick}'`), `he.js has no 'Pick a time': '${he.pick}'`);
});
