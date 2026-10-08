import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FocusSection } from './FocusSection';

describe('FocusSection', () => {
  it('brings the named section into view and gives it focus, once', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <>
        <section data-testid="gaps-section" tabIndex={-1}>
          Questions
        </section>
        <FocusSection testid="gaps-section" />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByTestId('gaps-section'));
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
