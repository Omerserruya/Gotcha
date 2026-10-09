'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type FieldValues,
  type Path,
  type UseFormProps,
  type UseFormReturn,
} from 'react-hook-form';
import { useCallback, useState } from 'react';
import type { z } from 'zod';

import { applyServerValidation } from './server-validation';
import { useUnsavedChangesWarning } from './use-unsaved-changes-warning';

export type SubmitState = 'idle' | 'submitting' | 'succeeded' | 'failed';

export interface AppForm<TValues extends FieldValues> extends UseFormReturn<TValues> {
  /** Wraps a submit handler with state tracking and server-error routing. */
  readonly submit: (event?: React.BaseSyntheticEvent) => Promise<void>;
  readonly submitState: SubmitState;
  /** The failure, when it was not field-level and needs general handling. */
  readonly submitError: unknown;
}

/**
 * The product's single form entry point.
 *
 * It exists so that every form in GOTCHA behaves the same way on the things
 * that are easy to get subtly wrong and invisible when you do:
 *
 *  - one schema drives both the types and the client validation,
 *  - server field errors land on their fields rather than in a toast,
 *  - submit state is tracked, so a button can disable itself and a user cannot
 *    double-submit a refund,
 *  - unsaved work is protected while the form is dirty.
 *
 * Autosave is deliberately absent. It is right for a draft and wrong for a
 * refund, so it is a per-form product decision, never a default.
 */
export function useAppForm<TValues extends FieldValues>(
  schema: z.ZodType<TValues, TValues>,
  options: {
    readonly onSubmit: (values: TValues) => Promise<void>;
    /** Guard unsaved changes while the form is dirty. Default: true. */
    readonly warnOnUnsavedChanges?: boolean;
  } & Omit<UseFormProps<TValues>, 'resolver'>,
): AppForm<TValues> {
  type Values = TValues;

  const { onSubmit, warnOnUnsavedChanges = true, ...formOptions } = options;

  const form = useForm<Values>({
    ...formOptions,
    resolver: zodResolver(schema),
    // Validate on blur rather than on every keystroke: telling someone their
    // email is invalid while they are still typing it is noise, not help.
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState<unknown>(null);

  useUnsavedChangesWarning(
    warnOnUnsavedChanges && form.formState.isDirty && submitState !== 'succeeded',
  );

  const submit = useCallback(
    async (event?: React.BaseSyntheticEvent) => {
      await form.handleSubmit(async (values) => {
        setSubmitState('submitting');
        setSubmitError(null);
        try {
          await onSubmit(values);
          setSubmitState('succeeded');
          // Reset to the submitted values so the form is no longer dirty but
          // still shows what was saved.
          form.reset(values, { keepValues: true });
        } catch (error) {
          setSubmitState('failed');
          const handled = applyServerValidation(
            error,
            form.setError,
            Object.keys(form.getValues()) as Path<Values>[],
          );
          if (!handled) setSubmitError(error);
        }
      })(event);
    },
    [form, onSubmit],
  );

  return { ...form, submit, submitState, submitError };
}
