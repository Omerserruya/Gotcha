import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UnavailableAction, UnavailableItem } from './Unavailable';

describe('★★ unavailable is a status, never an action (Omer, 2026-10-07)', () => {
  it('an action: its label, the tag, the reason - no button, nothing to press', () => {
    render(
      <UnavailableAction
        label="Test"
        tag="Not available yet"
        why="Coming with Phase 3"
        testid="a"
      />,
    );
    const action = screen.getByTestId('a');
    expect(action.tagName).toBe('SPAN');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action).toHaveAttribute('title', 'Coming with Phase 3');
    expect(action).toHaveTextContent('TestNot available yet');
    expect(action).toHaveTextContent('Coming with Phase 3');
    // The reason follows the tag with no stray separator (dev: "Preview | - In preview…").
    expect(action.textContent).not.toMatch(/-\s*Coming/);
    expect(action.querySelector('button, a, input')).toBeNull();
    fireEvent.click(action);
  });

  it('an item: title, reason as its line, the tag - no switch, no radio', () => {
    render(
      <UnavailableItem
        title="Continue on WhatsApp"
        tag="Not available yet"
        why="No handoff yet"
        testid="i"
      />,
    );
    const item = screen.getByTestId('i');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Continue on WhatsApp');
    expect(item).toHaveTextContent('No handoff yet');
    expect(item).toHaveTextContent('Not available yet');
    expect(item.querySelector('button, a, input')).toBeNull();
  });
});
