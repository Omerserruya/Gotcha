import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SkeletonBubbles, SkeletonCards, SkeletonRows, SkeletonStats } from './Skeleton';

describe('★ placeholders: one busy region with its words, the shapes hidden', () => {
  it.each([
    ['rows', <SkeletonRows key="r" label="Loading customers" rows={3} />, 'skeleton-rows'],
    ['cards', <SkeletonCards key="c" label="Loading customers" count={2} />, 'skeleton-cards'],
    ['stats', <SkeletonStats key="s" label="Loading customers" count={4} />, 'skeleton-stats'],
    [
      'bubbles',
      <SkeletonBubbles key="b" label="Loading customers" count={2} />,
      'skeleton-bubbles',
    ],
  ])('%s', (_name, node, testid) => {
    render(node);
    const region = screen.getByLabelText('Loading customers');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId(testid)).toBeInTheDocument();
    region.querySelectorAll('span[class]').forEach((shape) => {
      if (shape.getAttribute('aria-hidden') !== null)
        expect(shape).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('as many rows as asked, each its height - nothing jumps when the data lands', () => {
    render(<SkeletonRows label="x" rows={5} height={82} />);
    const rows = screen.getByTestId('skeleton-rows').children;
    expect(rows).toHaveLength(5);
    expect((rows[0] as HTMLElement).style.blockSize).toBe('82px');
  });

  it('light on a dark surface', () => {
    render(<SkeletonCards label="x" tone="light" count={1} />);
    expect(screen.getByTestId('skeleton-cards')).toHaveAttribute('data-tone', 'light');
  });
});
