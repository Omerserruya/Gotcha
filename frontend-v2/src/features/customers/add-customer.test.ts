import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { emailProblem, whatsappIdOf } from './add-customer';
import { addCustomer } from './customer-actions';

describe('★★ the phone, in the form the inbound path stores (wa_id: digits, no "+")', () => {
  it.each([
    ['054-123 4567', '972541234567'],
    ['0541234567', '972541234567'],
    ['+972 54 123 4567', '972541234567'],
    ['00972541234567', '972541234567'],
    ['972541234567', '972541234567'],
    ['03-921 4400', '97239214400'],
    ['+1 (415) 555-0100', '14155550100'],
  ])('%s → %s', (raw, id) => {
    expect(whatsappIdOf(raw)).toBe(id);
  });

  it.each(['', 'abc', '12345', '541234567', '+972 054 123 4567', '05412345678901', '+0 123 4567'])(
    'unparseable: %j',
    (raw) => {
      expect(whatsappIdOf(raw)).toBeNull();
    },
  );

  it('email: empty is fine; a malformed one is not', () => {
    expect(emailProblem('')).toBe(false);
    expect(emailProblem('dana@shop.co.il')).toBe(false);
    expect(emailProblem('dana@')).toBe(true);
  });
});

describe('★★ add - never a duplicate, never an overwrite', () => {
  beforeEach(() => {
    post.mockReset();
  });
  const paths = () =>
    post.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path);

  it('the phone is already here: that person opens; nothing is posted to create', async () => {
    post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({
        data: [{ id: 'k9', externalId: '972541234567', phone: '+972541234567' }],
        total: 1,
      }),
    );
    expect(await addCustomer({ name: 'UI TEST', phone: '054-123 4567', email: '' })).toEqual({
      ok: true,
      id: 'k9',
      existed: true,
    });
    expect(paths()).toEqual(['/api/contacts/segment']);
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({
      rules: [{ field: 'phone', operator: 'contains', value: '541234567' }],
    });
  });

  it('new: created as the WhatsApp identity, with exactly these fields', async () => {
    post.mockImplementation(
      async ({
        endpoint,
        payload,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
      }) =>
        endpoint.path === '/api/contacts/segment'
          ? payload.parse({ data: [], total: 0 })
          : payload.parse({ id: 'k-new' }),
    );
    expect(await addCustomer({ name: ' UI TEST ', phone: '+972 54 123 4567', email: '' })).toEqual({
      ok: true,
      id: 'k-new',
      existed: false,
    });
    expect((post.mock.calls[1]![0] as { body: unknown }).body).toStrictEqual({
      externalId: '972541234567',
      channel: 'WHATSAPP',
      displayName: 'UI TEST',
      phone: '972541234567',
    });
  });

  it('bad input is refused before any call; a 403 is said', async () => {
    expect(await addCustomer({ name: '', phone: '0541234567', email: '' })).toEqual({
      ok: false,
      reason: 'name',
    });
    expect(await addCustomer({ name: 'A', phone: 'abc', email: '' })).toEqual({
      ok: false,
      reason: 'phone',
    });
    expect(await addCustomer({ name: 'A', phone: '0541234567', email: 'x@' })).toEqual({
      ok: false,
      reason: 'email',
    });
    expect(post).not.toHaveBeenCalled();
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'authorization', status: 403 });
    });
    expect(await addCustomer({ name: 'A', phone: '0541234567', email: '' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
