import { describe, expect, it } from 'vitest';

import { safeInternalPath, safeLinkUrl, safeMediaUrl } from './safe-url';

describe('safeLinkUrl', () => {
  it('accepts ordinary web and contact schemes', () => {
    expect(safeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeLinkUrl('tel:+972500000000')).toBe('tel:+972500000000');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s', (hostile) => {
    expect(safeLinkUrl(hostile)).toBeNull();
  });

  it('★★ an in-app path stays a path instead of becoming a dead sentinel URL', () => {
    /*
     * It used to resolve onto `https://invalid.example` and RETURN that, so
     * `recovery_url` — which the identity provider sends as a path — came back
     * as a link to a domain that cannot resolve. An inert link that looks real
     * is the one thing this module promises callers they will never be handed.
     */
    expect(safeLinkUrl('/if/flow/default-recovery-flow/')).toBe('/if/flow/default-recovery-flow/');
  });

  it('⚠⚠ and a path gets the same whitespace treatment as everything else', () => {
    // It routes to `safeInternalPath`, so the tab/LF/CR handling is not
    // duplicated here — duplicating it is what produced the hole in the first
    // place.
    expect(safeLinkUrl('/\t/evil.example')).toBeNull();
    expect(safeLinkUrl('/.//evil.example')).toBeNull();
  });

  it('★ rejects something that is neither absolute nor a path', () => {
    /*
     * `example.com/a` has no scheme. Putting `https://` in front of it would
     * turn somebody's typo into a navigation to a host nothing checked, and
     * returning it resolved against the sentinel produced a dead link. Neither
     * reading is both safe and useful, so it is refused.
     */
    expect(safeLinkUrl('example.com/a')).toBeNull();
    expect(safeLinkUrl('../up')).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(safeLinkUrl('')).toBeNull();
    expect(safeLinkUrl(null)).toBeNull();
    expect(safeLinkUrl(undefined)).toBeNull();
  });
});

describe('safeMediaUrl', () => {
  it('accepts https and blob', () => {
    expect(safeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeMediaUrl('blob:https://app.example.com/abc')).toBe(
      'blob:https://app.example.com/abc',
    );
  });

  it('rejects plain http, which would be mixed content on an https page', () => {
    expect(safeMediaUrl('http://cdn.example.com/a.png')).toBeNull();
  });

  it('rejects data URLs, since an SVG one can carry a script', () => {
    expect(safeMediaUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
  });
});

describe('safeInternalPath', () => {
  it('accepts an in-app path', () => {
    expect(safeInternalPath('/inbox/conv_123')).toBe('/inbox/conv_123');
  });

  it('★ keeps the query and the fragment, which is where a deep link lives', () => {
    expect(safeInternalPath('/inbox?filter=open#thread')).toBe('/inbox?filter=open#thread');
  });

  const hostile: readonly string[] = [
    '//evil.example',
    'https://evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'inbox',

    /*
     * ════════════════════════════════════════════════════════════════════════
     * ★★ THE FIVE ABOVE ARE THE SHAPES SOMEBODY THOUGHT OF. THESE WALKED
     *    THROUGH ALL OF THEM.
     * ════════════════════════════════════════════════════════════════════════
     * The URL parser strips tab, LF and CR from ANYWHERE in a URL before it
     * parses. The old guard read the first two characters, so a tab between the
     * slashes satisfied every check and then vanished, leaving `//host`. Each
     * was measured producing `https://evil.example/`, not reasoned about.
     */
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/\t\\evil.example',

    /*
     * ★★ AND THESE TWO DEFEATED THE FIX RATHER THAN THE ORIGINAL.
     * They resolve to our own origin — the host is not in the URL when it is
     * parsed. `.` and `..` collapse to nothing and the pathname comes back as
     * `//evil.example`: an authority MANUFACTURED by normalisation, after the
     * origin comparison has already said yes.
     */
    '/.//evil.example',
    '/foo/..//evil.example',

    /*
     * ★★ AND THESE TWO ARE THE OLD FIXTURES WITH A PATH ON THEM.
     * `//evil.example` and `https://evil.example` have an EMPTY path, so a
     * guard that threw the host away and kept the path returns null for both
     * and looks correct. Mutation testing proved it: the origin comparison
     * could be deleted outright with every assertion still green. An attacker
     * sends the page they want somebody on, so the real payload has a path.
     */
    'https://evil.example/inbox/123',
    '//evil.example/inbox/123',
  ];

  it.each(hostile)('rejects %j', (candidate) => {
    // A notification's `link` is a free-text column somebody wrote. Treating
    // it as a trusted route is how a stored value becomes an open redirect.
    expect(safeInternalPath(candidate)).toBeNull();
  });

  it('⚠⚠ nothing that survives can navigate off this origin', () => {
    /*
     * The list above can only hold the spellings somebody wrote down. This asks
     * the question the value exists to answer — where does the BROWSER end up —
     * by resolving the approved output the way an `href` is resolved.
     *
     * ★ At the root, deliberately. Under `/v2` the prefix absorbs a smuggled
     *   authority (`/v2//evil` is a path), so this property is weaker in the
     *   only deployment anyone looks at, and a root-mounted build has nothing
     *   to absorb it.
     */
    const ORIGIN = 'https://dev.gotcha.co.il';
    for (const candidate of hostile) {
      const approved = safeInternalPath(candidate);
      if (approved === null) continue;
      expect(new URL(approved, `${ORIGIN}/`).origin, candidate).toBe(ORIGIN);
    }
    // Both directions: a predicate that rejected everything satisfies the loop.
    expect(safeInternalPath('/inbox/conv_123')).toBe('/inbox/conv_123');
  });

  it('★★ what it returns is already canonical, so a second parse cannot move it', () => {
    /*
     * The original defect was not only the missing spellings — it was checking
     * one string and navigating to a different one. Re-approving the output
     * must be a no-op, or whatever renders it can still reinterpret a value
     * this function approved.
     */
    for (const candidate of [...hostile, '/inbox/conv_123', '/inbox?filter=open#thread']) {
      const once = safeInternalPath(candidate);
      if (once === null) continue;
      expect(safeInternalPath(once), candidate).toBe(once);
    }
  });

  it('rejects empty input', () => {
    expect(safeInternalPath('')).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
  });
});
