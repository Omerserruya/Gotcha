'use client';

import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  /** Renders as the single child element instead of a `<button>`. */
  readonly asChild?: boolean;
  readonly iconOnly?: boolean;
  readonly children?: ReactNode;
}

/**
 * The button primitive.
 *
 * It has no copy of its own and no icon set: both are the caller's, which is
 * what keeps it usable in every locale and free of a visual opinion.
 *
 * Note `aria-disabled` over `disabled` for permission-blocked actions - see
 * the note in the stylesheet. Callers that need that behaviour pass
 * `aria-disabled` and handle the click themselves.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', fullWidth, iconOnly, asChild, type = 'button', ...rest },
  ref,
) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      ref={ref}
      // A button inside a form defaults to submitting it. That is almost never
      // what a toolbar or menu trigger wants, so the default is explicit.
      {...(asChild ? {} : { type })}
      className={[
        styles.button,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        iconOnly && styles.iconOnly,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
});
