import { zodResolver } from '@hookform/resolvers/zod';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dynamicComposeFormSchema } from '@ci-hub/common/schemas';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { PortsConfig } from './ports';

type Mapping = { hostPort: number | string; containerPort: number | string };

const Harness = ({ onValid, saved = { hostPort: 9091, containerPort: 9091 } }: { onValid: (data: unknown) => void; saved?: Mapping }) => {
  const form = useForm({
    resolver: zodResolver(dynamicComposeFormSchema as any),
    defaultValues: { services: [{ name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80, addPorts: [saved] }] },
  });
  return (
    <form onSubmit={form.handleSubmit(onValid)}>
      <PortsConfig control={form.control as never} register={form.register as never} serviceIndex={0} errors={form.formState.errors as never} />
      <button type="submit">Save</button>
    </form>
  );
};

const hostPort = () => screen.getAllByPlaceholderText('9091')[0] as HTMLElement;
const containerPort = () => screen.getAllByPlaceholderText('9091')[1] as HTMLElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('PortsConfig port range', () => {
  it.each([
    ['70000', 'Host port must be at most 65535'],
    ['0', 'Host port must be at least 1'],
  ])('refuses the host port %s with the rule under the field', async (port, message) => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    fireEvent.change(hostPort(), { target: { value: port } });
    save();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('refuses a container port above 65535', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    fireEvent.change(containerPort(), { target: { value: '70000' } });
    save();

    expect(await screen.findByText('Container port must be at most 65535')).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('accepts ports in range as numbers', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    fireEvent.change(hostPort(), { target: { value: '8081' } });
    fireEvent.change(containerPort(), { target: { value: '80' } });
    save();

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ addPorts: [{ hostPort: 8081, containerPort: 80 }] }] });
  });

  it('leaves an env reference and a range as typed', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    fireEvent.change(hostPort(), { target: { value: '${EXTRA_PORT}' } });
    fireEvent.change(containerPort(), { target: { value: '8000-8010' } });
    save();

    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
    expect(onValid.mock.calls[0]?.[0]).toMatchObject({ services: [{ addPorts: [{ hostPort: '${EXTRA_PORT}', containerPort: '8000-8010' }] }] });
  });

  it('refuses a bad host port saved as text until it is changed', async () => {
    const onValid = vi.fn();
    render(<Harness onValid={onValid} saved={{ hostPort: '70000', containerPort: '80' }} />);

    expect(hostPort()).toHaveValue('70000');
    save();

    expect(await screen.findByText('Host port must be at most 65535')).toBeInTheDocument();
    expect(onValid).not.toHaveBeenCalled();
  });
});
