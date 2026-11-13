import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemInspectorContainer } from '../system-inspector';

const { mockUseOptionalUserContext, mockUseQuery } = vi.hoisted(() => ({
  mockUseOptionalUserContext: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ appDataRootHostPath: '/opt/ci-hub' }),
}));

vi.mock('@/context/user-context', () => ({
  useOptionalUserContext: () => mockUseOptionalUserContext(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => mockUseQuery(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getFullInspectionOptions: vi.fn(() => ({ queryKey: ['inspection'] })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const sampleInspection = {
  containers: [],
  ports: { allocations: [], untracked: [] },
  health: {
    cpu: { load: 0.25, cores: 4, model: 'Test CPU' },
    memory: { total: 8 * 1024 ** 3, used: 2 * 1024 ** 3, free: 6 * 1024 ** 3, percent: 25 },
    disk: { total: 100 * 1024 ** 3, used: 20 * 1024 ** 3, free: 80 * 1024 ** 3, percent: 20 },
    uptime: 3600,
    platform: 'linux',
    hostname: 'hub-test',
    dockerVersion: '27.0.0',
    containerCount: { running: 0, stopped: 0, total: 0 },
  },
  timestamp: '2026-11-12T00:00:00.000Z',
};

describe('SystemInspectorContainer Trust & Protocol Boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({
      data: sampleInspection,
      isLoading: false,
      refetch: vi.fn(),
      isFetching: false,
      dataUpdatedAt: Date.now(),
    });
  });

  it('shows provisional trust protocols as Fail-Closed by default', () => {
    mockUseOptionalUserContext.mockReturnValue({
      didAuthEnabled: false,
      keriOobiEnabled: false,
      allowCloudFallback: false,
    });

    render(<SystemInspectorContainer />);

    expect(screen.getByTestId('trust-protocols-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('trust-protocol-row-did-key-siop')).toHaveTextContent('Fail-Closed');
    expect(screen.getByTestId('trust-protocol-row-keri-oobi')).toHaveTextContent('Fail-Closed');
    expect(screen.getByTestId('trust-protocol-row-cloud-fallback')).toHaveTextContent('Fail-Closed');
    expect(screen.getByTestId('trust-protocol-row-forward-auth')).toHaveTextContent('Active');
  });

  it('reflects enabled flags accurately when opted in', () => {
    mockUseOptionalUserContext.mockReturnValue({
      didAuthEnabled: true,
      keriOobiEnabled: true,
      allowCloudFallback: true,
    });

    render(<SystemInspectorContainer />);

    expect(screen.getByTestId('trust-protocol-row-did-key-siop')).toHaveTextContent('Active');
    expect(screen.getByTestId('trust-protocol-row-keri-oobi')).toHaveTextContent('Active');
    expect(screen.getByTestId('trust-protocol-row-cloud-fallback')).toHaveTextContent('Active');
  });
});
