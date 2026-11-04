import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { requestBack } from '@/lib/back-request';

import { PhotoLink } from './PhotoLink';

const props = {
  url: 'https://dev.gotcha.co.il/api/bff/a.jpg',
  alt: '',
  className: 'photo',
  openLabel: 'Open the photo',
  closeLabel: 'Close the photo',
  testId: 'photo-m1',
} as const;

describe('PhotoLink', () => {
  // Omer, 2026-11-04: in the app a photo opened the phone's browser, which answered 401.
  it('★ on the phone a photo opens full screen in the app, and closes', () => {
    render(
      <ol data-variant="phone" data-stream-scroller="" data-testid="scroller">
        <li>
          <PhotoLink {...props} />
        </li>
      </ol>,
    );
    const link = screen.getByTestId('photo-m1');
    const scroller = screen.getByTestId('scroller');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    // The native shell's link rule leaves it alone (`outsideUrl`).
    expect(link).toHaveAttribute('data-in-app');
    expect(screen.getByTestId('photo-m1-viewer')).toBeInTheDocument();
    // Over everything, not inside the thread's layers (Omer, 2026-11-04).
    expect(screen.getByTestId('photo-m1-viewer').parentElement).toBe(document.body);
    expect(scroller).toHaveStyle({ overflow: 'hidden' });
    fireEvent.click(screen.getByTestId('photo-m1-viewer-close'));
    expect(screen.queryByTestId('photo-m1-viewer')).toBeNull();
    expect(scroller.style.overflow).toBe('');
  });

  it('on the website it stays a link to a new tab', () => {
    render(<PhotoLink {...props} />);
    const link = screen.getByTestId('photo-m1');
    expect(link).toHaveAttribute('target', '_blank');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('photo-m1-viewer')).toBeNull();
  });

  it("★ Android's Back closes the viewer, and with it closed Back is not spent", () => {
    render(
      <ol data-variant="phone">
        <li>
          <PhotoLink {...props} />
        </li>
      </ol>,
    );
    act(() => {
      screen.getByTestId('photo-m1').click();
    });
    let spent = false;
    act(() => {
      spent = requestBack();
    });
    expect(spent).toBe(true);
    expect(screen.queryByTestId('photo-m1-viewer')).toBeNull();
    expect(requestBack()).toBe(false);
  });
});
