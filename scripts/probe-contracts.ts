/**
 * Contract probe.
 *
 * The platform's OpenAPI document declares no response schemas: every success
 * is `EnvelopeUnknown`. Rather than guess the shapes, this prints the SHAPE of
 * a live response - keys and value types only, never values - so the schemas
 * in `src/api/contracts` can be written from evidence.
 *
 * Usage:
 *   API_BASE_URL=https://dev.gotcha.co.il \
 *   GOTCHA_ACCESS_TOKEN=<authentik access token> \
 *   [GOTCHA_TENANT_ID=<tenant>] \
 *   npm run api:probe
 *
 * It never prints a value, so its output is safe to paste into a ticket.
 */

const ENDPOINTS = [
  '/api/auth/me',
  '/api/auth/me/memberships',
  '/api/permissions/me',
  '/api/permissions/catalog',
  '/api/permissions/features',
];

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length === 0 ? 'array<empty>' : [shapeOf(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        shapeOf(item, depth + 1),
      ]),
    );
  }
  return typeof value;
}

async function main(): Promise<void> {
  const baseUrl = process.env.API_BASE_URL;
  const token = process.env.GOTCHA_ACCESS_TOKEN;
  if (!baseUrl || !token) {
    process.stderr.write('Set API_BASE_URL and GOTCHA_ACCESS_TOKEN.\n');
    process.exitCode = 1;
    return;
  }

  for (const path of ENDPOINTS) {
    const response = await fetch(new URL(path, baseUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(process.env.GOTCHA_TENANT_ID ? { 'x-tenant-id': process.env.GOTCHA_TENANT_ID } : {}),
      },
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = '<non-JSON>';
    }

    const envelope =
      typeof body === 'object' && body !== null && 'data' in body
        ? (body as { data: unknown }).data
        : body;

    process.stdout.write(
      `\n${path}  →  ${response.status}\n${JSON.stringify(shapeOf(envelope), null, 2)}\n`,
    );
  }
}

void main();
