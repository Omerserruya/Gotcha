/**
 * Moved to `@chatcenter/shared` (lib/workspace-policy) so services/auth can
 * write the same policy this service reads - see that file for why.
 *
 * Re-exported under the original path so the five call sites in this service
 * did not have to move for a change that is not about them.
 */
export {
  DEFAULT_POLICY,
  MAX_LIST_ITEMS,
  MAX_ITEM_CHARS,
  PolicyValidationError,
  validateStringList,
  validatePolicyPatch,
  getPolicy,
  getPolicyPrompt,
  setPolicy,
  validateAgainstPolicy,
  type BusinessPolicy,
} from "@chatcenter/shared";
