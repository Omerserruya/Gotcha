import { describe, expect, it } from 'vitest';

import {
  TEMPLATE_MAX_BYTES,
  placeholderChip,
  previewDocument,
  templateBytes,
  templateProblem,
} from './email-template';

describe('templateProblem', () => {
  it('passes a template that carries {{content}}', () => {
    expect(templateProblem('<p>{{content}}</p>')).toBeNull();
  });

  it('refuses a template without {{content}}, or with only a near miss', () => {
    expect(templateProblem('<p>hello</p>')).toBe('noContent');
    expect(templateProblem('<p>{{ content }}</p>')).toBe('noContent');
    expect(templateProblem('<p>{{Content}}</p>')).toBe('noContent');
  });

  it('refuses an empty template, whitespace included', () => {
    expect(templateProblem('')).toBe('empty');
    expect(templateProblem('  \n ')).toBe('empty');
  });

  it('counts UTF-8 bytes, so Hebrew reaches the limit at half the characters', () => {
    expect(templateBytes('א')).toBe(2);
    // 12 ASCII bytes, so the Hebrew fills the rest exactly.
    const hebrew = '{{content}}.' + 'א'.repeat((TEMPLATE_MAX_BYTES - 12) / 2);
    expect(templateBytes(hebrew)).toBe(TEMPLATE_MAX_BYTES);
    expect(templateProblem(hebrew)).toBeNull();
    expect(templateProblem(hebrew + 'a')).toBe('tooLarge');
    // The same character count in ASCII is well under.
    expect(templateProblem('{{content}}' + 'a'.repeat(hebrew.length))).toBeNull();
  });
});

describe('previewDocument', () => {
  const fill = (html: string, values = {}) =>
    previewDocument(html, {
      content: '<div data-preview-content>here</div>',
      values,
      chip: placeholderChip,
    });

  it('puts the screen block where {{content}} stands, every time it stands', () => {
    expect(fill('<td>{{content}}</td><td>{{content}}</td>')).toBe(
      '<td><div data-preview-content>here</div></td><td><div data-preview-content>here</div></td>',
    );
  });

  it('fills real names as text, escaped', () => {
    expect(
      fill('<b>{{agent_name}}</b> {{business_name}}', {
        agent_name: '<img src=x onerror=alert(1)>',
        business_name: 'Halvo & "Co"',
      }),
    ).toBe('<b>&lt;img src=x onerror=alert(1)&gt;</b> Halvo &amp; &quot;Co&quot;');
  });

  it('draws a placeholder with no value as a chip, never an invented name', () => {
    const out = fill('Hi {{customer_name}}');
    expect(out).toContain('{{customer_name}}</span>');
    expect(out.startsWith('Hi <span')).toBe(true);
  });

  it('leaves a placeholder the sender does not know as the author wrote it', () => {
    expect(fill('{{unsubscribe}}')).toBe('{{unsubscribe}}');
  });
});
