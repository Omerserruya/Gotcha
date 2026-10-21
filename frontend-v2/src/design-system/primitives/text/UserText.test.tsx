import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UserText } from './UserText';

/**
 * Hebrew inside an English screen, isolated.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DEFECT WAS FOUND BY READING A SENTENCE THAT MADE NO SENSE
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk found *"What you sell"* on Settings · Workspace holding Hebrew
 * with embedded Latin. The runs reordered: the sentence started in Hebrew,
 * jumped to English, and the closing parenthesis landed on the wrong side.
 *
 * **The stored value was correct.** The page sets `dir` from the URL's locale
 * and every element inherits it, so the bidirectional algorithm resolved a
 * right-to-left string against a left-to-right paragraph.
 *
 * A DOM test cannot see visual order - no test in this repo can, which is why
 * this one went to production. What it CAN pin is that the isolation is present
 * and that it is `auto` rather than inherited, which is the whole mechanism.
 */

const HEBREW_WITH_LATIN = 'קוסמטיקה טבעית (organic) לעור רגיש';

describe('★★ user content is isolated from the page direction', () => {
  it('★★ renders a bdi element, which is the isolate', () => {
    render(<UserText>{HEBREW_WITH_LATIN}</UserText>);

    const node = screen.getByText(HEBREW_WITH_LATIN);
    expect(node.tagName).toBe('BDI');
  });

  it('★★ sets dir="auto" explicitly rather than relying on the default', () => {
    /*
     * `<bdi>` carries an implicit auto direction, and an implicit behaviour is
     * one a CSS reset or a wrapping component can take away. Stated, so the
     * mechanism survives somebody styling this element.
     */
    render(<UserText>{HEBREW_WITH_LATIN}</UserText>);
    expect(screen.getByText(HEBREW_WITH_LATIN)).toHaveAttribute('dir', 'auto');
  });

  it('★ passes a className and a testid through, so it can replace a span', () => {
    // It has to be adoptable at an existing call site without restructuring,
    // or it will not be adopted.
    render(
      <UserText className="x" data-testid="value">
        {HEBREW_WITH_LATIN}
      </UserText>,
    );
    const node = screen.getByTestId('value');
    expect(node).toHaveClass('x');
    expect(node.tagName).toBe('BDI');
  });

  it('★ leaves Latin text alone - isolation is not transformation', () => {
    render(<UserText>Natural cosmetics (organic)</UserText>);
    expect(screen.getByText('Natural cosmetics (organic)')).toBeInTheDocument();
  });
});

describe('★★ an email in user text survives an edge that rewrites emails (#418, Cloudflare)', () => {
  it('the server render never holds a whole email; the page reads it whole', async () => {
    const { renderToString } = await import('react-dom/server');
    const text = 'שירות hello@halvo-dev.test.';
    const html = renderToString(<UserText>{text}</UserText>);
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(html).toContain('hello<!-- -->@<!-- -->halvo-dev.test.');
    render(<UserText data-testid="u">{text}</UserText>);
    expect(screen.getByTestId('u').textContent).toBe(text);
  });

  it('text without an "@" is left as it is', async () => {
    const { renderToString } = await import('react-dom/server');
    expect(renderToString(<UserText>plain text</UserText>)).toBe(
      '<bdi dir="auto">plain text</bdi>',
    );
  });
});
