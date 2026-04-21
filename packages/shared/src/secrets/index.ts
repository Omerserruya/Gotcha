import { EnvSecretProvider } from "./env-provider";
export interface SecretProvider { get(tenantId: string, key: string): Promise<string | undefined>; }

let provider: SecretProvider = new EnvSecretProvider();

export function setSecretProvider(p: SecretProvider): void { provider = p; }
export function resetSecretProvider(): void { provider = new EnvSecretProvider(); }

export async function getSecret(tenantId: string, key: string): Promise<string | undefined> {
  if (!tenantId || typeof tenantId !== "string") throw new Error("getSecret: tenantId required");
  if (!key || typeof key !== "string") throw new Error("getSecret: key required");
  return provider.get(tenantId, key);
}

export async function requireSecret(tenantId: string, key: string): Promise<string> {
  const v = await getSecret(tenantId, key);
  if (!v) throw new Error(`Missing secret ${key} for tenant ${tenantId}`);
  return v;
}
