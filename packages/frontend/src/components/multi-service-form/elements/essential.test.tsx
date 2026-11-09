import { zodResolver } from '@hookform/resolvers/zod';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dynamicComposeFormSchema } from '@ci-hub/common/schemas';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { EssentialConfig } from './essential';

const Harness = ({ onValid }: { onValid: (data: unknown) => void }) => {
  const form = useForm({
    resolver: zodResolver(dynamicComposeFormSchema as any),
    defaultValues: { services: [{ name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80 }] },
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

  it('leaves an env reference as typed', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    submitWithPort('${APP_PORT}');

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ internalPort: '${APP_PORT}' }] });
  });
});
