import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { knowledgeSourceSchema } from '@/api/contracts/knowledge';
import knowledge from '@/i18n/messages/en/knowledge.json';

/*
 * K8 (Omer, 2026-10-12): each kind of knowledge has one icon, drawn on the
 * Add sheet's card, on its row on 08 and in its drawer's head. Each place is
 * rendered here and its icon compared with the map's - so a place that picks
 * its own glyph fails, whichever place it is.
 */
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  Link: ({
    href: _href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: unknown;
    children?: ReactNode;
    scroll?: boolean;
  }) => <a {...rest}>{children}</a>,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'knowledge') =>
    createTranslator({ locale: 'en', messages: { knowledge }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));
vi.mock('./add/ConnectedSources', () => ({ ConnectedSources: () => null }));

import { AddKnowledge } from './add/AddKnowledge';
import { DocumentTypeLead } from './DocumentDrawer';
import { KnowledgeScreen } from './KnowledgeScreen';
import {
  KNOWLEDGE_TYPE_ICONS,
  KNOWLEDGE_TYPES,
  knowledgeTypeOf,
  type KnowledgeType,
} from './knowledge-type';

/** The glyph the map gives a kind, drawn on its own: its paths. */
function mapGlyph(type: KnowledgeType): string {
  const Icon = KNOWLEDGE_TYPE_ICONS[type];
  const { container, unmount } = render(<Icon />);
  const paths = container.querySelector('svg')!.innerHTML;
  unmount();
  return paths;
}

/** The one kind icon inside `place`: decorative, and the map's glyph for that kind. */
function expectKindIcon(place: HTMLElement, type: KnowledgeType) {
  const icons = place.querySelectorAll('svg[data-knowledge-type]');
  expect(icons, 'one kind icon').toHaveLength(1);
  const icon = icons[0]!;
  expect(icon).toHaveAttribute('data-knowledge-type', type);
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon.innerHTML, `${type}: the map's glyph`).toBe(mapGlyph(type));
}

/** One stored document per kind, as the writers name them. */
const WRITTEN: Readonly<Record<KnowledgeType, string>> = {
  document: 'file',
  page: 'url',
  drive: 'google_drive',
  text: 'text',
};

describe('★★ K8 - one icon per kind of knowledge', () => {
  it('four kinds, four different glyphs', () => {
    expect(KNOWLEDGE_TYPES).toEqual(['document', 'page', 'drive', 'text']);
    expect(new Set(KNOWLEDGE_TYPES.map(mapGlyph)).size).toBe(4);
  });

  it('the kind of a stored document, from the writers’ sourceType - and none for the rest', () => {
    expect(
      ['file', 'url', 'onboarding_scan', 'google_drive', 'drive', 'text'].map(knowledgeTypeOf),
    ).toEqual(['document', 'page', 'page', 'drive', 'drive', 'text']);
    for (const other of ['confluence', 'historical_conversations', 'readiness_answer', 'pdf', '']) {
      expect(knowledgeTypeOf(other), other).toBeNull();
    }
  });

  it('the Add sheet: each card, its kind’s icon', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ knowledge }}>
        <AddKnowledge />
      </NextIntlClientProvider>,
    );
    for (const type of KNOWLEDGE_TYPES) expectKindIcon(screen.getByTestId(`add-way-${type}`), type);
  });

  it('08: each document’s row, its kind’s icon; none of the four, no icon', async () => {
    const source = knowledgeSourceSchema.parse({
      id: 'k1',
      name: 'Company Knowledge',
      documents: [
        ...KNOWLEDGE_TYPES.map((type) => ({ id: type, title: type, sourceType: WRITTEN[type] })),
        { id: 'conv', title: 'How the team answers', sourceType: 'historical_conversations' },
      ],
    });
    render(
      await KnowledgeScreen({
        sources: [source],
        unanswered: [],
        conflicts: [],
        everImported: true,
      }),
    );
    for (const type of KNOWLEDGE_TYPES) expectKindIcon(screen.getByTestId(`doc-${type}`), type);
    expect(screen.getByTestId('doc-conv').querySelector('svg[data-knowledge-type]')).toBeNull();
  });

  it('the drawer’s head: its kind’s icon; none of the four, nothing', () => {
    for (const type of KNOWLEDGE_TYPES) {
      const { container, unmount } = render(<DocumentTypeLead type={WRITTEN[type]} />);
      expectKindIcon(container, type);
      unmount();
    }
    const { container } = render(<DocumentTypeLead type="confluence" />);
    expect(container).toBeEmptyDOMElement();
  });
});
