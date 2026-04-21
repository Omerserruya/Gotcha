import type { SecretProvider } from "./index";

export class EnvSecretProvider implements SecretProvider {
  async get(tenantId: string, key: string): Promise<string | undefined> {
    const normTenant = normalize(tenantId);
    const normKey = key.toUpperCase();
    const tenantScoped = process.env[`TENANT_${normTenant}_${normKey}`];
    if (tenantScoped) return tenantScoped;
    return process.env[normKey];
  }
}

// Normalization rules:
//  - allowed chars in tenantId: [A-Za-z0-9_-]
//  - replace '-' with '_'
//  - uppercase
//  - if other chars present → throw Error("invalid tenantId shape for env provider")
function normalize(tenantId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) throw new Error(`EnvSecretProvider: invalid tenantId ${tenantId}`);
  return tenantId.replace(/-/g, "_").toUpperCase();
}
