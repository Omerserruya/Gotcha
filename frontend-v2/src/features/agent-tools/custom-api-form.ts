import {
  toSlug,
  type CustomApiAuthKind,
  type CustomApiMethod,
  type CustomApiTool,
} from '@/api/contracts/agent-tools';

import type { CustomApiInput } from './agent-tools-actions';

/**
 * The custom API builder's form, as plain state - the legacy builder's
 * fields (CustomApiToolsSection.tsx), checked here so the rules are tested
 * apart from the screen. Secrets start empty and stay write-only: empty
 * keeps what the route stores.
 */
export interface CustomApiDraft {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly method: CustomApiMethod;
  readonly urlTemplate: string;
  readonly allowedHosts: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
  readonly bodyTemplate: string;
  readonly authKind: CustomApiAuthKind;
  readonly authIn: 'header' | 'query';
  readonly authName: string;
  readonly bearer: string;
  readonly apiKey: string;
  readonly basicUser: string;
  readonly basicPass: string;
  /** Input: JSON schema as text. */
  readonly parameters: string;
  /** Output: comma-separated dotted paths. */
  readonly responseFields: string;
  readonly category: 'READ' | 'WRITE' | 'DELETE' | 'ACTION';
  /** The route's own risk word, kept as legacy set it; Backend maps it with the category. */
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly isActive: boolean;
  readonly timeoutMs: string;
}

export const EMPTY_PARAMETERS = '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';

export function draftOf(tool: CustomApiTool | null): CustomApiDraft {
  return {
    slug: tool?.slug ?? '',
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    whenToUse: tool?.whenToUse ?? '',
    whenNotToUse: tool?.whenNotToUse ?? '',
    method: tool?.method ?? 'GET',
    urlTemplate: tool?.urlTemplate ?? '',
    allowedHosts: tool?.allowedHosts.join(', ') ?? '',
    headers: Object.entries(tool?.headers ?? {}).map(([key, value]) => ({ key, value })),
    bodyTemplate: tool?.bodyTemplate ?? '',
    authKind: tool?.auth.kind ?? 'none',
    authIn: tool?.auth.in ?? 'header',
    authName: tool?.auth.name ?? '',
    bearer: '',
    apiKey: '',
    basicUser: '',
    basicPass: '',
    parameters:
      tool?.parameters === undefined ? EMPTY_PARAMETERS : JSON.stringify(tool.parameters, null, 2),
    responseFields: tool?.responseFields?.join(', ') ?? '',
    category: tool && tool.category !== 'UNKNOWN' ? tool.category : 'READ',
    riskLevel: tool && tool.riskLevel !== 'UNKNOWN' ? tool.riskLevel : 'MEDIUM',
    isActive: tool?.isActive ?? true,
    timeoutMs: String(tool?.timeoutMs ?? 10_000),
  };
}

export type DraftProblem =
  | 'name'
  | 'slug'
  | 'description'
  | 'whenToUse'
  | 'urlTemplate'
  | 'allowedHosts'
  | 'hostNotAllowed'
  | 'authName'
  | 'secret'
  | 'parameters'
  | 'timeout';

const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The URL's host, with `{{placeholders}}` stood in for: `null` when it is not an https/http URL. */
function hostOfTemplate(template: string): string | null {
  try {
    const url = new URL(template.trim().replace(/\{\{[^}]*\}\}/g, 'x'));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * The draft as the route's body, or what is missing. `isNew` decides
 * whether a secret is required: an edit keeps the stored one.
 */
export function checkDraft(
  draft: CustomApiDraft,
  { isNew, hasSecrets }: { readonly isNew: boolean; readonly hasSecrets: boolean },
): { readonly ok: true; readonly input: CustomApiInput } | { readonly ok: false; readonly problems: readonly DraftProblem[] } {
  const problems: DraftProblem[] = [];
  if (draft.name.trim() === '') problems.push('name');
  const slug = toSlug(isNew ? draft.slug || draft.name : draft.slug);
  if (slug === '') problems.push('slug');
  if (draft.description.trim() === '') problems.push('description');
  if (draft.whenToUse.trim() === '') problems.push('whenToUse');
  const host = hostOfTemplate(draft.urlTemplate);
  if (host === null) problems.push('urlTemplate');
  const hosts = csv(draft.allowedHosts);
  if (hosts.length === 0) problems.push('allowedHosts');
  else if (host !== null && !hosts.includes(host)) problems.push('hostNotAllowed');
  if (draft.authKind === 'api_key' && draft.authName.trim() === '') problems.push('authName');
  const secrets: Record<string, string> =
    draft.authKind === 'bearer'
      ? { bearer: draft.bearer }
      : draft.authKind === 'api_key'
        ? { apiKey: draft.apiKey }
        : draft.authKind === 'basic'
          ? { basicUser: draft.basicUser, basicPass: draft.basicPass }
          : {};
  const keepsStored = !isNew && hasSecrets;
  if (!keepsStored && Object.values(secrets).some((v) => v === '')) problems.push('secret');
  let parameters: unknown = null;
  try {
    parameters = JSON.parse(draft.parameters || '{}');
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      problems.push('parameters');
    }
  } catch {
    problems.push('parameters');
  }
  const timeout = Number(draft.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60_000) problems.push('timeout');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    input: {
      slug,
      name: draft.name,
      description: draft.description,
      whenToUse: draft.whenToUse,
      whenNotToUse: draft.whenNotToUse,
      method: draft.method,
      urlTemplate: draft.urlTemplate,
      allowedHosts: hosts,
      headers: Object.fromEntries(
        draft.headers
          .filter(({ key, value }) => key.trim() !== '' && value !== '')
          .map(({ key, value }) => [key.trim(), value]),
      ),
      authKind: draft.authKind,
      authIn: draft.authIn,
      authName: draft.authName,
      secrets,
      parameters,
      bodyTemplate: draft.bodyTemplate,
      responseFields: csv(draft.responseFields),
      category: draft.category,
      riskLevel: draft.riskLevel,
      isActive: draft.isActive,
      timeoutMs: timeout,
    },
  };
}
