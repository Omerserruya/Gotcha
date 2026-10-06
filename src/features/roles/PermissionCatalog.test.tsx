import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { permissionDefSchema } from '@/api/contracts/permission-catalog';
import messages from '@/i18n/messages/en/roles.json';

import { PermissionCatalog } from './PermissionCatalog';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE DEFECT HERE WAS IN A STYLESHEET, AND IT HAD NO TEST FILE AT ALL
 * ════════════════════════════════════════════════════════════════════════════
 * Permissions showed `Crm` and `Ai` as headings. Three instruments could not
 * see it and each for a different, sound reason:
 *
 *   · a source sweep - `group.domain` is lowercase `crm` in the source, and the
 *     capital came from `text-transform: capitalize` in `Roles.module.css`;
 *   · a screaming-identifier probe - `crm` has no underscore and no capitals;
 *   · any value-side helper - `humaniseCode` was never called on this path.
 *
 * ★ A PRESENTATIONAL TRANSFORM THAT CHANGES WHAT A WORD SAYS IS NOT
 *   PRESENTATIONAL. CSS can capitalise `crm`; only code knows it is CRM.
 *
 * These assertions read the rendered text, which is where the humaniser can be
 * checked. They CANNOT see the stylesheet - a CSS module is inert in this
 * renderer - so the transform itself is guarded repo-wide in
 * `features/home/raw-values.test.ts`, beside the other disguises of this shape.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'roles') =>
    createTranslator({ locale: 'en', messages: { roles: messages }, namespace }),
}));

const perm = (over: Record<string, unknown>) =>
  permissionDefSchema.parse({ key: 'x:y:z', displayName: 'Something', ...over });

describe('★★ a domain heading is a name, not an identifier', () => {
  it('★★ renders `crm` as CRM and `ai` as AI', async () => {
    render(
      await PermissionCatalog({
        permissions: [
          perm({ key: 'crm:contacts:read', domain: 'crm', displayName: 'See contacts' }),
          perm({ key: 'ai:replies:edit', domain: 'ai', displayName: 'Edit replies' }),
        ],
      }),
    );
    expect(screen.getByText('CRM')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    /*
     * The exact strings a browser walk read off the page. `getByText` is exact
     * by default, so these are the assertions that go red if the capitalising
     * moves back into the stylesheet AND the humaniser is dropped - which is
     * how the defect was composed.
     */
    expect(screen.queryByText('Crm')).toBeNull();
    expect(screen.queryByText('Ai')).toBeNull();
  });

  it('★ spells a multi-word domain as a sentence, not as Title Case', async () => {
    render(
      await PermissionCatalog({
        permissions: [perm({ key: 'business_core:role:manage', domain: 'business_core' })],
      }),
    );
    expect(screen.getByText('Business core')).toBeInTheDocument();
  });

  it('★ keeps a domain it has never seen readable rather than dropping it', async () => {
    render(
      await PermissionCatalog({
        permissions: [perm({ key: 'warehouse:stock:read', domain: 'warehouse' })],
      }),
    );
    expect(screen.getByText('Warehouse')).toBeInTheDocument();
  });

  it('does not re-word the platform’s own permission names', async () => {
    // `displayName` and `description` are already written. A second vocabulary
    // is a second thing to drift.
    render(
      await PermissionCatalog({
        permissions: [
          perm({ key: 'crm:contacts:read', domain: 'crm', displayName: 'See contact details' }),
        ],
      }),
    );
    expect(screen.getByText('See contact details')).toBeInTheDocument();
  });
});

describe('★★ the scope note is a marker, not the explanation repeated per row', () => {
  const scopedRows = () =>
    Array.from({ length: 6 }, (_, i) =>
      perm({ key: `crm:contacts:a${i}`, domain: 'crm', scoped: true, displayName: `Do ${i}` }),
    );

  it('★★ never repeats the page’s own explanation under the rows', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * AN EXPLANATION REPEATED PER ROW IS NOT EMPHASIS, IT IS WALLPAPER
     * ════════════════════════════════════════════════════════════════════════
     * Each scoped row said *"How far this reaches depends on the role's
     * setting"*, and a browser walk found it under twenty-plus rows. The page
     * above the catalogue already says it once and better, in
     * `catalog.scopeIsPerRole`.
     *
     * Asserted as an absence of the SENTENCE rather than a count of the marker,
     * because a count cannot tell one long caption from six short ones - and a
     * count is what I would have reached for.
     */
    render(await PermissionCatalog({ permissions: scopedRows() }));
    expect(screen.queryByText(/depends on the role/i)).toBeNull();
    expect(screen.queryByText(/how far this reaches/i)).toBeNull();
  });

  it('★★ marks every scoped row, and the marker stands alone', async () => {
    /*
     * The marker still has to mean something to a reader who skipped the
     * paragraph, which is why it names the thing that limits the permission
     * rather than saying "Scoped".
     */
    render(await PermissionCatalog({ permissions: scopedRows() }));
    const marks = screen.getAllByText(/limited by the role/i);
    expect(marks).toHaveLength(6);
    expect(marks[0]!.textContent!.length).toBeLessThan(40);
  });

  it('★★ marks nothing on a permission that takes no scope', async () => {
    /*
     * A marker on every row would say the dimension always applies, which is
     * the same lie as a disabled control on a row that has none.
     */
    render(
      await PermissionCatalog({
        permissions: [perm({ key: 'crm:contacts:read', domain: 'crm', scoped: false })],
      }),
    );
    expect(screen.queryByText(/limited by the role/i)).toBeNull();
  });
});
