'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';

import styles from './Inbox.module.css';

/**
 * A photo in a message: on the website a link that opens it in a new tab; on
 * the phone (`/m`, inside a `data-variant='phone'` stream) it opens full
 * screen over the thread, in the app.
 *
 * ⚠ The phone app could not open it any other way: a new tab leaves the
 *   WebView for the phone's browser, which has no GOTCHA session, so the file
 *   answered 401 (Omer, 2026-11-04).
 */
export function PhotoLink({
  url,
  alt,
  className,
  openLabel,
  closeLabel,
  testId,
}: {
  readonly url: string;
  readonly alt: string;
  readonly className: string | undefined;
  readonly openLabel: string;
  readonly closeLabel: string;
  readonly testId: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.currentTarget.closest("[data-variant='phone']") === null) return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        aria-label={openLabel}
        data-testid={testId}
        onClick={onClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a customer's file, from our host or theirs */}
        <img src={url} alt={alt} loading="lazy" />
      </a>
      {open ? (
        <div
          className={styles.photoViewer}
          role="dialog"
          aria-modal="true"
          aria-label={openLabel}
          data-testid={`${testId}-viewer`}
          onClick={() => setOpen(false)}
        >
          <button
            type="button"
            className={styles.photoViewerClose}
            aria-label={closeLabel}
            data-testid={`${testId}-viewer-close`}
            autoFocus
            onClick={() => setOpen(false)}
          >
            <X size={22} aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- the same file, whole */}
          <img
            className={styles.photoViewerImage}
            src={url}
            alt={alt}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}
