import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The way on that remembers itself. Mocked: nothing is saved. */
const { save, router } = vi.hoisted(() => ({
  save: { saveStep: vi.fn() },
  router: { push: vi.fn() },
}));
vi.mock('./step-actions', () => save);
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

import { StepLink } from './StepLink';

beforeEach(() => {
  save.saveStep.mockReset();
  router.push.mockReset();
});

describe('★★ StepLink', () => {
  it('★★ saves the step reached, THEN opens it', async () => {
    const order: string[] = [];
    // Recorded when the save FINISHES: the push must wait for it.
    save.saveStep.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('saved');
      return true;
    });
    router.push.mockImplementation(() => order.push('push'));
    render(
      <StepLink href="/onboarding/channels" step="channels" data-testid="go">
        Continue
      </StepLink>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('go'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(save.saveStep).toHaveBeenCalledWith('channels');
    expect(router.push).toHaveBeenCalledWith('/onboarding/channels');
    expect(order).toEqual(['saved', 'push']);
  });

  it('★ a save that fails, or rejects, never blocks the way on', async () => {
    save.saveStep.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(
      <StepLink href="/onboarding/live" step="live" data-testid="go">
        Continue
      </StepLink>,
    );
    await act(async () => fireEvent.click(screen.getByTestId('go')));
    expect(router.push).toHaveBeenCalledWith('/onboarding/live');
  });

  it('★★ a preview saves nothing: the link just goes', async () => {
    render(
      <StepLink href="/onboarding/live" step="live" preview data-testid="go">
        Continue
      </StepLink>,
    );
    await act(async () => fireEvent.click(screen.getByTestId('go')));
    expect(save.saveStep).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
