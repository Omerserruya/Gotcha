/**
 * The header that carries the active tenant upstream.
 *
 * The platform resolves tenancy from the access token plus this header, never
 * from a body or a path parameter, and validates the value against the
 * caller's memberships. It is set in exactly one place - the BFF proxy - so no
 * feature can forget it, and no component can guess at it.
 */
export const TENANT_HEADER = 'x-tenant-id';
