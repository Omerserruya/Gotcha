import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { appPath } from '@/lib/base-path';

import { CenteredLoader, Loader } from './Loader';

describe('★★ the GOTCHA loader (Omer, 2026-10-06)', () => {
  it('a status with its words, at its size, with the mark for its tone', () => {
    render(<Loader size={32} tone="light" label="Loading" />);
    const loader = screen.getByRole('status', { name: 'Loading' });
    expect(loader).toHaveAttribute('data-tone', 'light');
    expect(loader.style.getPropertyValue('--size')).toBe('32px');
    // Through appPath: a bare "/brand/…" would miss the /v2 mount.
    expect(loader.style.getPropertyValue('--mark')).toBe(
      `url(${appPath('/brand/gotcha-mark-light.png')})`,
    );
  });

  it('dark mark and 48px by default', () => {
    render(<Loader label="Loading" />);
    const loader = screen.getByRole('status');
    expect(loader).toHaveAttribute('data-tone', 'dark');
    expect(loader.style.getPropertyValue('--size')).toBe('48px');
    expect(loader.style.getPropertyValue('--mark')).toContain('gotcha-mark-dark.png');
  });

  it('centred in its area', () => {
    render(<CenteredLoader label="Loading" minHeight={240} />);
    expect(screen.getByTestId('centered-loader').style.getPropertyValue('--min')).toBe('240px');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('★ Omer’s motion, and none for whoever asked for less: a still mark at 60%', () => {
    const css = readFileSync('src/design-system/primitives/loader/Loader.module.css', 'utf8');
    expect(css).toMatch(/animation:\s*breath 1\.8s ease-in-out infinite/);
    expect(css).toMatch(/animation:\s*fill 1\.8s cubic-bezier\(0\.65, 0, 0\.35, 1\) infinite/);
    expect(css).toMatch(/opacity:\s*0\.12/);
    const still = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(still).toMatch(/animation:\s*none/);
    expect(still).toMatch(/opacity:\s*0\.6/);
  });

  it('★ the marks are files, not 160KB of base64 in the bundle', () => {
    for (const tone of ['dark', 'light']) {
      expect(readFileSync(`public/brand/gotcha-mark-${tone}.png`).subarray(1, 4).toString()).toBe(
        'PNG',
      );
    }
    expect(
      readFileSync('src/design-system/primitives/loader/Loader.module.css', 'utf8'),
    ).not.toMatch(/base64/);
  });
});
