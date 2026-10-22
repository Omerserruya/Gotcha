/**
 * The details form's id - the overlay's footer Save (a server-rendered button)
 * submits it with `form=`. Here, not in the client component: a server file
 * importing a value from a 'use client' module gets a reference, not the string.
 */
export const PROFILE_FORM_ID = 'billing-profile-form';
