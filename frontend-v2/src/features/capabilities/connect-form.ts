import type { CredentialField } from '@/api/contracts/integrations';

/**
 * The credentials to send: exactly the fields the catalogue declares, each
 * trimmed, a choice only from its options. `null` when one is missing.
 */
export function credentialsFor(
  fields: readonly CredentialField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.key] ?? '').trim();
    if (value === '') {
      if (field.required) return null;
      continue;
    }
    if (field.type === 'select' && field.options && !field.options.includes(value)) return null;
    credentials[field.key] = value;
  }
  return Object.keys(credentials).length > 0 ? credentials : null;
}
