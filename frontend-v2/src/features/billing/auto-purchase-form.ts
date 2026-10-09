/**
 * The auto-purchase form's id - the overlay's footer Save (a server-rendered
 * button) submits it with `form=`. Kept out of the 'use client' module: a
 * server file importing a value from one gets a reference, not the string.
 */
export const AUTO_PURCHASE_FORM_ID = 'auto-purchase-form';
