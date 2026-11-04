'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

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
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    /*
     * The thread under it does not scroll while it is open: a swipe on the
     * photo moved the conversation behind it.
     */
    const scroller = link.current?.closest<HTMLElement>('[data-stream-scroller]') ?? null;
    const before = scroller?.style.overflow ?? '';
    if (scroller) scroller.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      if (scroller) scroller.style.overflow = before;
    };
  }, [open]);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.currentTarget.closest("[data-variant='phone']") === null) return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <>
      <a
        ref={link}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        aria-label={openLabel}
        data-testid={testId}
        // Not the native shell's "out to the browser": on the phone it opens here.
        data-in-app=""
        onClick={onClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a customer's file, from our host or theirs */}
        <img src={url} alt={alt} loading="lazy" />
      </a>
      {/*
        ⚠⚠ PORTALED TO <body>. Drawn inside the thread, the viewer sat in the
           scroller's layers: a photo near the top or bottom of the screen
           opened it under the bar or the composer, and there was no way out
           (Omer, 2026-11-04). At the body it is over everything, always.
      */}
      {open && typeof document !== 'undefined'
        ? createPortal(
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
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
