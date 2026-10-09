/**
 * The attribute that marks the stream's scroller for `StreamPin`.
 *
 * ⚠ Its own module, not an export of `StreamPin.tsx`: a server component that
 *   imports a value from a `'use client'` module receives a client reference,
 *   not the string.
 */
export const STREAM_SCROLLER = 'data-stream-scroller';
