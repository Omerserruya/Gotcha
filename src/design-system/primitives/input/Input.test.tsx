import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input } from './Input';

describe('Input', () => {
  it('associates its label with the control', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('announces an error and marks the field invalid', () => {
    render(<Input label="Email" error="Enter a valid email address" />);
    const field = screen.getByLabelText('Email');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a valid email address');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('describes the field with its hint when there is no error', () => {
    render(<Input label="Email" hint="We only use this for sign-in" />);
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'We only use this for sign-in',
    );
  });

  it('hides the hint once an error takes its place', () => {
    render(<Input label="Email" hint="Optional" error="Required" />);
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
  });
});

describe('★ a trailing control sits inside the field, at its end', () => {
  it('beside the input in one box - not floating under the hint', () => {
    render(
      <Input
        label="Token"
        hint="From the console"
        trailing={<button type="button">Show</button>}
      />,
    );
    const input = screen.getByLabelText('Token');
    const show = screen.getByRole('button', { name: 'Show' });
    expect(input.parentElement).toBe(show.parentElement?.parentElement);
    expect(input.className).toMatch(/inputWithTrailing/);
    // The hint comes after the box, not between the input and its control.
    expect(screen.getByText('From the console').previousElementSibling).toBe(input.parentElement);
  });

  it('without one, the input stands alone as before', () => {
    render(<Input label="Name" />);
    expect(screen.getByLabelText('Name').className).not.toMatch(/inputWithTrailing/);
  });
});
