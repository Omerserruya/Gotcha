/** Twilio's Account SID: "AC" and 32 hex digits, as Twilio issues it. */
export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

export function accountSidProblem(raw: string): boolean {
  return !ACCOUNT_SID.test(raw.trim());
}
