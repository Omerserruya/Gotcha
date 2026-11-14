/**
 * The phone's Back button, as a cancelable window event (shell `NativeBridge`
 * sends it from the native app). Something open over the screen - the photo
 * viewer - calls `preventDefault()` and closes; nothing did, and Back goes
 * back a page, as it did before anyone listened.
 */
export const BACK_REQUEST_EVENT = 'gotcha:back-request';

/** Asks whoever is open to close. `true`: something did, so Back is spent. */
export function requestBack(target: EventTarget = window): boolean {
  const event = new Event(BACK_REQUEST_EVENT, { cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
