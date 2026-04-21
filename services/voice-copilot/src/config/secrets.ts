import { getSecret, requireSecret } from "@chatcenter/shared";

export async function getTwilioAuthToken(tenantId: string): Promise<string> {
  return requireSecret(tenantId, "TWILIO_AUTH_TOKEN");
}

export async function getTwilioAccountSid(tenantId: string): Promise<string | undefined> {
  return getSecret(tenantId, "TWILIO_ACCOUNT_SID");
}

export async function getSttApiKey(tenantId: string): Promise<string | undefined> {
  return getSecret(tenantId, "STT_API_KEY");
}
