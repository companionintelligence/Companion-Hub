import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { editorJson, toastSuccess, toastError } = vi.hoisted(() => ({
  editorJson: { value: '' },
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

vi.mock('./elements/essential', () => ({ EssentialConfig: () => <div /> }));
vi.mock('./elements/environment', () => ({ EnvironmentConfig: () => <div /> }));
vi.mock('./elements/volumes', () => ({ VolumesConfig: () => <div /> }));
vi.mock('./elements/ports', () => ({ PortsConfig: () => <div /> }));
vi.mock('./elements/advanced', () => ({ AdvancedConfig: () => <div /> }));
// The real editor is CodeMirror. This one hands the form the JSON a person typed, as the real one does on each change.
vi.mock('./json-compose-editor', async () => {
  const { useEffect } = await import('react');
  return {
    JsonComposeEditor: ({ onChange }: { onChange: (json: string, error?: string) => void }) => {
      // Once, on mount, like the real editor's first validation. The form passes a new onChange on every render.
      useEffect(() => onChange(editorJson.value, undefined), []);
      return <div data-testid="json-editor" />;
    },
  };
});

import { MultiServiceForm } from './multi-service-form';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

const command = "sh -c 'while :; do :; done'";

function openJsonEditorWith(json: unknown) {
  editorJson.value = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  fireEvent.click(screen.getByRole('button', { name: 'JSON Editor' }));
  expect(screen.getByTestId('json-editor')).toBeInTheDocument();
}

describe('MultiServiceForm Save JSON', () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
    act(() => {
      useMultiServiceStore.getState().setServices([{ _id: 'web-id', name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80 }]);
      useMultiServiceStore.setState({ overrides: undefined } as never);
    });
  });

  const overrides = [{ architecture: 'arm64' as const, services: [{ name: 'web', image: 'alpine:3.20', internalPort: 8080 }] }];

  it('keeps a typed overrides block when saving JSON', async () => {
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    openJsonEditorWith({ services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80 }], overrides });
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ overrides });
  });

  it('keeps the saved overrides when Save all saves the form', async () => {
    act(() => {
      useMultiServiceStore.setState({ overrides } as never);
    });
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save all' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ services: [expect.objectContaining({ name: 'web' })], overrides });
  });

  it.each(['Save JSON', 'Save all'])('sends one save for a double click on %s and keeps the button disabled until it settles', async (label) => {
    let settle: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<MultiServiceForm onSubmit={onSubmit} />);
    if (label === 'Save JSON') {
      openJsonEditorWith({ services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80, command }] });
    }

    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () => settle());
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
  });

  it('saves the edited JSON the way Save all does', async () => {
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    openJsonEditorWith({ services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80, command }] });
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [submitted] = onSubmit.mock.calls[0] as [{ services: Array<Record<string, unknown>> }];
    expect(submitted.services).toEqual([expect.objectContaining({ name: 'web', image: 'alpine:3.20', command })]);
    expect(submitted.services[0]).not.toHaveProperty('_id');
    // The save's own toast ("Custom app ... updated successfully!") reports the outcome, not a second one here.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(useMultiServiceStore.getState().services[0]).toMatchObject({ _id: 'web-id', command });
  });

  it('saves nothing when the JSON breaks a form rule', async () => {
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    openJsonEditorWith({
      services: [
        { name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80 },
        { name: 'web', image: 'redis:7', internalPort: 6379 },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Service names must be unique.'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says the JSON is invalid instead of throwing on an emptied editor', async () => {
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    openJsonEditorWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Invalid JSON format'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('applies the JSON to the form and says so when nothing saves it', async () => {
    render(<MultiServiceForm />);

    openJsonEditorWith({ services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80, command }] });
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Service configuration updated successfully'));
    expect(useMultiServiceStore.getState().services[0]).toMatchObject({ command });
  });
});
