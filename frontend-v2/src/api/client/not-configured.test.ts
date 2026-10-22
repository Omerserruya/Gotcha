import { describe, expect, it } from 'vitest';

import { ApiError } from './api-error';
import { isNotConfigured } from './not-configured';

const refusal = (status: number, developerMessage?: string, code?: string) =>
  new ApiError({ kind: status === 500 ? 'server' : 'validation', status, developerMessage, code });

describe('★★ "not set up in this environment" - by its code, and by both spellings until then', () => {
  it.each([
    ['the code', refusal(503, 'whatever', 'NOT_CONFIGURED')],
    ['connectors-admin', refusal(500, 'hubspot_oauth_not_configured')],
    [
      'crm-oauth (Zoho)',
      refusal(500, 'Zoho OAuth not configured (set ZOHO_CLIENT_ID + ZOHO_REDIRECT_URI)'),
    ],
    ['calendar-oauth', refusal(500, 'Google Calendar OAuth not configured')],
    ['knowledge-oauth', refusal(500, 'Confluence OAuth not configured')],
  ])('%s', (_, cause) => {
    expect(isNotConfigured(cause)).toBe(true);
  });

  it.each([
    ['another 500', refusal(500, 'Failed to start OAuth')],
    ['the words on a 400', refusal(400, 'not configured')],
    ['another code', refusal(500, 'x', 'NOT_FOUND')],
    ['not an API error', new Error('not_configured')],
  ])('not: %s', (_, cause) => {
    expect(isNotConfigured(cause)).toBe(false);
  });
});
