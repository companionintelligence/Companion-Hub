import { zodResolver } from '@hookform/resolvers/zod';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dynamicComposeFormSchema } from '@ci-hub/common/schemas';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { EssentialConfig } from './essential';

const Harness = ({ onValid, savedPort = 80 }: { onValid: (data: unknown) => void; savedPort?: number | string }) => {
  const form = useForm({
    resolver: zodResolver(dynamicComposeFormSchema as any),
    defaultValues: { services: [{ name: 'web', image: 'nginx:alpine', isMain: true, internalPort: savedPort }] },
  });
  return (
    <form onSubmit={form.handleSubmit(onValid)}>
      <EssentialConfig register={form.register as never} serviceIndex={0} errors={form.formState.errors as never} />
      <button type="submit">Save</button>
    </form>
  );
};

const submitWithPort = (port: string) => {
  fireEvent.change(screen.getByPlaceholderText('9091'), { target: { value: port } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('EssentialConfig internal port', () => {
  it.each([
    ['70000', 'Internal port must be at most 65535'],
    ['0', 'Internal port must be at least 1'],
  ])('refuses %s with the rule under the field', async (port, message) => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    submitWithPort(port);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('accepts a port in range as a number', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    submitWithPort('8080');

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ internalPort: 8080 }] });
  });

  it('sends a port saved as text as a number when it is saved again', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} savedPort="8080" />);

    expect(screen.getByPlaceholderText('9091')).toHaveValue('8080');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ internalPort: 8080 }] });
  });

  it('refuses a bad port saved as text until it is changed', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} savedPort="70000" />);

    expect(screen.getByPlaceholderText('9091')).toHaveValue('70000');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Internal port must be at most 65535')).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('leaves an env reference as typed', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    submitWithPort('${APP_PORT}');

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ internalPort: '${APP_PORT}' }] });
  });
});
