import { render, screen } from '@/tests/test-utils';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemInspectorContainer } from '../system-inspector';

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}));

const mockUseQuery = vi.mocked(useQuery);

describe('SystemInspectorContainer', () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
  });

  it('renders the security digest with contextual findings and app scores', async () => {
    mockUseQuery.mockReturnValue({
      data: {
        containers: [],
        ports: { allocations: [], untracked: [] },
        health: {
          cpu: { load: 12, cores: 8, model: 'Test CPU' },
          memory: { total: 16, used: 8, free: 8, percent: 50 },
          disk: { total: 100, used: 40, free: 60, percent: 40 },
          uptime: 3600,
          platform: 'Linux',
          hostname: 'ci-hub',
          dockerVersion: '27.0.0',
          containerCount: { running: 2, stopped: 0, total: 2 },
        },
        security: {
          summary: {
            score: 54,
            findings: 2,
            critical: 1,
            high: 1,
            medium: 0,
            low: 0,
            cloudflareExposedApps: 1,
            tailscaleExposedApps: 0,
            localApps: 1,
          },
          overview: '1 critical finding needs immediate attention.',
          findings: [
            {
              id: 'vaultwarden-weak-credentials',
              severity: 'critical',
              title: 'Vaultwarden appears to use weak or default credentials',
              description: 'The app is exposed through Cloudflare with weak credentials.',
              remediation: 'Rotate the password immediately.',
              appName: 'Vaultwarden',
              exposure: 'cloudflare',
            },
          ],
          apps: [
            {
              appUrn: 'vaultwarden:ci-marketplace',
              appName: 'Vaultwarden',
              status: 'running',
              exposure: 'cloudflare',
              sensitivity: 'high',
              score: 32,
              findings: 2,
              topFinding: 'Vaultwarden appears to use weak or default credentials',
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
      isLoading: false,
      refetch: vi.fn(),
      isFetching: false,
      dataUpdatedAt: Date.now(),
    } as any);

    render(<SystemInspectorContainer />);

    expect(await screen.findByText('Security Digest')).toBeInTheDocument();
    expect(screen.getAllByText('54/100').length).toBeGreaterThan(0);
    expect(screen.getByText('Contextual Findings')).toBeInTheDocument();
    expect(screen.getAllByText('Vaultwarden appears to use weak or default credentials').length).toBeGreaterThan(0);
    expect(screen.getByText('Per-App Posture')).toBeInTheDocument();
    expect(screen.getAllByText('Vaultwarden').length).toBeGreaterThan(0);
  });

  it('shows a clean-state message when the security digest has no findings', async () => {
    mockUseQuery.mockReturnValue({
      data: {
        containers: [],
        ports: { allocations: [], untracked: [] },
        health: {
          cpu: { load: 12, cores: 8, model: 'Test CPU' },
          memory: { total: 16, used: 8, free: 8, percent: 50 },
          disk: { total: 100, used: 40, free: 60, percent: 40 },
          uptime: 3600,
          platform: 'Linux',
          hostname: 'ci-hub',
          dockerVersion: '27.0.0',
          containerCount: { running: 1, stopped: 0, total: 1 },
        },
        security: {
          summary: {
            score: 100,
            findings: 0,
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            cloudflareExposedApps: 0,
            tailscaleExposedApps: 0,
            localApps: 1,
          },
          overview: 'No immediate security issues were detected.',
          findings: [],
          apps: [],
        },
        timestamp: new Date().toISOString(),
      },
      isLoading: false,
      refetch: vi.fn(),
      isFetching: false,
      dataUpdatedAt: Date.now(),
    } as any);

    render(<SystemInspectorContainer />);

    expect(await screen.findByText('No immediate security issues were detected.')).toBeInTheDocument();
    expect(
      screen.getByText('No security findings detected from the current configuration, installed apps, and runtime posture.'),
    ).toBeInTheDocument();
  });
});
