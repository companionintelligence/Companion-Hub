import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (params) return `${key}:${JSON.stringify(params)}`;
      return key;
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateAppMetadataMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@ci-hub/common/schemas', () => ({
  CURRENT_SCHEMA_VERSION: 5,
}));

vi.mock('../../components/app-description-editor/app-description-editor', () => ({
  AppDescriptionEditor: () => <div>description</div>,
}));

import { AppDetailsTabs } from './app-details-tabs';
import type { AppInfo, AppMetadata } from '@/types/app.types';

function makeInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    urn: 'test-app:store1',
    id: 'test-app',
    name: 'Test App',
    short_desc: 'A test app',
    description: 'Full description',
    author: 'Test Author',
    source: 'https://github.com/test',
    version: '2.0.0',
    cihub_app_version: 1,
    available: true,
    deprecated: false,
    port: 8080,
    force_expose: false,
    generate_vapid_keys: false,
    categories: ['utilities'],
    form_fields: [],
    https: false,
    exposable: true,
    no_gui: false,
    supported_architectures: ['amd64', 'arm64'],
    dynamic_config: true,
    created_at: 0,
    updated_at: 1700000000000,
    force_pull: false,
    ...overrides,
  } as AppInfo;
}

const defaultMetadata: AppMetadata = {
  latestVersion: 2,
  latestDockerVersion: '2.1.0',
  composeSchemaVersion: 5,
  hasCustomConfig: false,
  minHubVersion: '0.5.0',
  localSubdomain: 'test-app',
};

describe('AppDetailsTabs — compatibility surfacing', () => {
  it('displays supported architectures', () => {
    render(<AppDetailsTabs info={makeInfo()} metadata={defaultMetadata} />);

    const archRow = screen.getByTestId('app-architectures');
    expect(archRow).toBeInTheDocument();
    expect(archRow).toHaveTextContent('amd64, arm64');
  });

  it('displays min Hub version when present', () => {
    render(<AppDetailsTabs info={makeInfo()} metadata={defaultMetadata} />);

    const minVersionRow = screen.getByTestId('app-min-hub-version');
    expect(minVersionRow).toBeInTheDocument();
    expect(minVersionRow).toHaveTextContent('0.5.0');
  });

  it('hides min Hub version when not set', () => {
    render(<AppDetailsTabs info={makeInfo()} metadata={{ ...defaultMetadata, minHubVersion: undefined }} />);

    expect(screen.queryByTestId('app-min-hub-version')).not.toBeInTheDocument();
  });

  it('hides architectures when empty', () => {
    render(<AppDetailsTabs info={makeInfo({ supported_architectures: [] })} metadata={defaultMetadata} />);

    expect(screen.queryByTestId('app-architectures')).not.toBeInTheDocument();
  });
});
