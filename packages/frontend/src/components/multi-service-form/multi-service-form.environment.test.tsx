import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('./elements/essential', () => ({ EssentialConfig: () => <div /> }));
vi.mock('./elements/volumes', () => ({ VolumesConfig: () => <div /> }));
vi.mock('./elements/ports', () => ({ PortsConfig: () => <div /> }));
vi.mock('./elements/advanced', () => ({ AdvancedConfig: () => <div /> }));
vi.mock('./json-compose-editor', () => ({ JsonComposeEditor: () => <div /> }));

import { MultiServiceForm } from './multi-service-form';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

describe('MultiServiceForm environment values', () => {
  it('says the value is required under the field', async () => {
    act(() => {
      useMultiServiceStore.getState().setServices([
        {
          _id: 'web-id',
          name: 'web',
          image: 'alpine:3.20',
          isMain: true,
          internalPort: 80,
          environment: [{ key: 'FOO', value: undefined as never }],
        },
      ]);
    });
    const onSubmit = vi.fn();
    render(<MultiServiceForm onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save all' }));

    expect(await screen.findByText('Environment value is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
