import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from '@/api/client/api-error';

import { useAppForm } from './use-app-form';

const schema = z.object({
  email: z.email('Enter a valid email address'),
});

type Values = z.infer<typeof schema>;

function TestForm({ onSubmit }: { onSubmit: (values: Values) => Promise<void> }) {
  const form = useAppForm<Values>(schema, {
    onSubmit,
    defaultValues: { email: '' },
    warnOnUnsavedChanges: false,
  });

  return (
    <form onSubmit={form.submit}>
      <label htmlFor="email">Email</label>
      <input id="email" {...form.register('email')} />
      {form.formState.errors.email ? (
        <span role="alert">{form.formState.errors.email.message}</span>
      ) : null}
      <button type="submit">Save</button>
      <output>{form.submitState}</output>
    </form>
  );
}

describe('useAppForm', () => {
  it('blocks submission on a client validation failure', async () => {
    const onSubmit = vi.fn();
    render(<TestForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports success once the submit handler resolves', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TestForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ email: 'person@example.com' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('succeeded'));
  });

  it('lands a server rejection on the field rather than losing it', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError({
        kind: 'validation',
        fieldErrors: [{ field: 'email', message: 'That address is already in use' }],
      }),
    );
    render(<TestForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That address is already in use');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('failed'));
  });
});
