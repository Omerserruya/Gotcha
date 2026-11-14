/**
 * The v8 home's lead form: what it sends and how it reads the answer.
 * fetch is always a stub here - a real POST from dev would reach the team's
 * Telegram and Airtable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_ENDPOINT, leadFromForm, sendLead } from '../../src/lib/home-lead.mjs';

const FILLED = { name: ' Dana ', phone: ' 050-1234567 ', site: ' shop.example.co.il ', mail: ' dana@example.com ' };

test('a filled form becomes the waitlist body, trimmed, with the website in both fields', () => {
  assert.deepEqual(leadFromForm(FILLED, 'landing-home-cta'), {
    firstName: 'Dana',
    phone: '050-1234567',
    company: 'shop.example.co.il',
    companyDomain: 'shop.example.co.il',
    email: 'dana@example.com',
    source: 'landing-home-cta',
  });
});

test('an empty email is left out, not sent as "" (the schema rejects it)', () => {
  const body = leadFromForm({ ...FILLED, mail: '   ' }, 'landing-home-cta');
  assert.equal('email' in body, false);
});

for (const field of ['name', 'phone', 'site']) {
  test(`no lead without ${field}`, () => {
    assert.equal(leadFromForm({ ...FILLED, [field]: '  ' }, 'landing-home-cta'), null);
  });
}

function stub(status) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status };
  };
  return { calls, fetchImpl };
}

test('posts JSON to the waitlist on this host', async () => {
  const { calls, fetchImpl } = stub(201);
  const body = leadFromForm(FILLED, 'landing-home-cta');
  assert.equal(await sendLead(body, fetchImpl), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LEAD_ENDPOINT);
  assert.equal(LEAD_ENDPOINT, '/api/waitlist');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test('409 (already on the list) is a success for the visitor', async () => {
  assert.equal(await sendLead({}, stub(409).fetchImpl), 'sent');
});

for (const status of [400, 403, 404, 429, 500, 502, 503]) {
  test(`${status} is a failure the form shows`, async () => {
    assert.equal(await sendLead({}, stub(status).fetchImpl), 'failed');
  });
}

test('a request that never completes is a failure, not a throw', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await sendLead({}, fetchImpl), 'failed');
});
