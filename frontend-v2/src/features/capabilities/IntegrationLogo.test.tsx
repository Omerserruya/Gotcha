import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { INTEGRATION_LOGOS, IntegrationLogo } from './IntegrationLogo';

const PUBLIC = join(process.cwd(), 'public', 'integrations');

describe('★ every integration has a mark, shipped with the app', () => {
  // The map, not the directory: a file nobody maps is caught below.
  it.each(Object.entries(INTEGRATION_LOGOS))('%s → public/integrations/%s exists', (_, file) => {
    expect(existsSync(join(PUBLIC, file))).toBe(true);
  });

  it('no shipped file is unmapped', () => {
    const mapped = new Set(Object.values(INTEGRATION_LOGOS));
    expect(readdirSync(PUBLIC).filter((f) => !f.startsWith('.') && !mapped.has(f))).toEqual([]);
  });

  it('the dev catalogue’s fifteen providers each have one; custom_api gets the plug', () => {
    for (const slug of [
      'shopify',
      'woocommerce',
      'fireberry',
      'stripe',
      'paypal',
      'hubspot',
      'salesforce',
      'zoho_crm',
      'monday',
      'google_calendar',
      'returngo',
      'postgresql',
      'mongodb',
      'aws_rds',
      'airtable',
    ]) {
      expect(INTEGRATION_LOGOS[slug], slug).toBeDefined();
    }
    const { container } = render(<IntegrationLogo slug="custom_api" size="rail" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('a local path, decorative', () => {
    const { container } = render(<IntegrationLogo slug="shopify" size="head" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^(\/[\w-]+)?\/integrations\/shopify\.svg$/);
    expect(img).toHaveAttribute('alt', '');
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
