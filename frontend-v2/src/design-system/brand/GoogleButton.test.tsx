import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GoogleButton } from './GoogleButton';

/**
 * ★★ Google's button, by Google's rules (branding-guidelines, 2026-11-22):
 * the values are asserted where they live, so a "tidy-up" to tokens shows.
 */
describe('★★ GoogleButton', () => {
  it('★ a link when it can go straight there, with the logo decorative and the words read', () => {
    render(
      <GoogleButton
        label="המשך עם Google"
        href="https://auth.example/source/oauth/login/google/"
      />,
    );
    const link = screen.getByRole('link', { name: 'המשך עם Google' });
    expect(link).toHaveAttribute('href', 'https://auth.example/source/oauth/login/google/');
    expect(link.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('★ a button when something must happen first, and it can be disabled', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <GoogleButton label="Continue with Google" onClick={onClick} disabled />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    rerender(<GoogleButton label="Continue with Google" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('⚠⚠ Google’s light theme and type, by its own numbers', () => {
    const css = readFileSync('src/design-system/brand/GoogleButton.module.css', 'utf8');
    expect(css).toMatch(/border-color:\s*#747775/);
    expect(css).toMatch(/background-color:\s*#fff;/);
    expect(css).toMatch(/color:\s*#1f1f1f/);
    expect(css).toMatch(/font-family:\s*var\(--font-google-sans\)/);
    expect(css).toMatch(/font-size:\s*14px/);
    expect(css).toMatch(/line-height:\s*20px/);
    expect(css).toMatch(/font-weight:\s*500/);
  });

  it('⚠⚠ the face is served from this repo, with its licence beside it', () => {
    const faces = readFileSync('src/design-system/fonts/fonts.css', 'utf8');
    expect(faces).toContain("font-family: 'Google Sans'");
    expect(faces).toContain("url('./google-sans-hebrew-500-normal.woff2')");
    expect(faces).not.toMatch(/fonts\.(gstatic|googleapis)\.com/);
    expect(readFileSync('src/design-system/fonts/google-sans-OFL.txt', 'utf8')).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    );
  });
});
