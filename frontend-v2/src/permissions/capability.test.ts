import { describe, expect, it } from 'vitest';

import {
  ALLOWED,
  HIDDEN,
  denied,
  isEnabled,
  isVisible,
  narrowest,
  needsApproval,
  requiresApproval,
  unavailable,
} from './capability';

describe('capability', () => {
  it('treats an approval requirement as enabled but flagged', () => {
    const capability = requiresApproval();
    expect(isEnabled(capability)).toBe(true);
    expect(needsApproval(capability)).toBe(true);
  });

  it('keeps a denied action visible so it can explain itself', () => {
    const capability = denied('missing_permission');
    expect(isVisible(capability)).toBe(true);
    expect(isEnabled(capability)).toBe(false);
  });

  it('hides only what is explicitly hidden', () => {
    expect(isVisible(HIDDEN)).toBe(false);
    expect(isVisible(unavailable('invalid_state'))).toBe(true);
  });

  it('narrows to the most restrictive of several constraints', () => {
    expect(narrowest(ALLOWED, requiresApproval()).status).toBe('requires_approval');
    expect(narrowest(requiresApproval(), unavailable('invalid_state')).status).toBe('unavailable');
    expect(narrowest(unavailable('invalid_state'), denied()).status).toBe('denied');
    expect(narrowest(denied(), HIDDEN).status).toBe('hidden');
  });

  it('preserves the reason code through narrowing', () => {
    expect(narrowest(ALLOWED, unavailable('integration_disconnected')).reason).toBe(
      'integration_disconnected',
    );
  });
});
