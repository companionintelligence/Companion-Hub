import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addService } = vi.hoisted(() => ({ addService: vi.fn() }));

vi.mock('@/stores/multiServiceStore', () => ({
  useMultiServiceStore: () => ({
    services: [{ _id: 'web', name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80, environment: [], volumes: [], addPorts: [] }],
    activeService: 0,
    isDirty: false,
    error: '',
    updateFromJson: vi.fn(),
    setActiveService: vi.fn(),
    addService,
    removeService: vi.fn(),
    updateService: vi.fn(),
    validate: vi.fn(() => true),
    setIsDirty: vi.fn(),
  }),
}));

vi.mock('./elements/essential', () => ({ EssentialConfig: () => <div /> }));
vi.mock('./elements/environment', () => ({ EnvironmentConfig: () => <div /> }));
vi.mock('./elements/volumes', () => ({ VolumesConfig: () => <div /> }));
vi.mock('./elements/ports', () => ({ PortsConfig: () => <div /> }));
vi.mock('./elements/advanced', () => ({ AdvancedConfig: () => <div /> }));
vi.mock('./json-compose-editor', () => ({ JsonComposeEditor: () => <div /> }));

import { MultiServiceForm } from './multi-service-form';

describe('MultiServiceForm add service', () => {
  beforeEach(() => {
    addService.mockClear();
  });

  it('adds a service from a named button', () => {
    render(<MultiServiceForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Add service' }));

    expect(addService).toHaveBeenCalledOnce();
  });
});
