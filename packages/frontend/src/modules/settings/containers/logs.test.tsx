import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsContainer } from './logs';

const mockDownloadHubLogsSdk = vi.fn();
const mockDownloadResponseAsFile = vi.fn();
const mockToastError = vi.fn();
const mockUseSSE = vi.fn();

vi.mock('@/api-client/sdk.gen', () => ({
  downloadHubLogs: (...args: unknown[]) => mockDownloadHubLogsSdk(...args),
}));

vi.mock('@/lib/hooks/use-sse', () => ({
  useSSE: (...args: unknown[]) => mockUseSSE(...args),
}));

vi.mock('./log-download', () => ({
  downloadResponseAsFile: (...args: unknown[]) => mockDownloadResponseAsFile(...args),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

vi.mock('@/components/logs-terminal/logs-terminal', () => ({
  LogsTerminal: ({ toolbarActions }: { toolbarActions?: ReactNode }) => <div data-testid="logs-terminal-toolbar">{toolbarActions}</div>,
}));

describe('LogsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads full hub logs from the backend endpoint', async () => {
    const response = new Response(new Blob(['hub logs'], { type: 'text/plain' }), { status: 200 });
    mockDownloadHubLogsSdk.mockResolvedValue({ response });
    mockDownloadResponseAsFile.mockResolvedValue(undefined);

    render(<LogsContainer />);

    expect(mockUseSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'ci-hub-logs',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Download full logs' }));

    expect(mockDownloadHubLogsSdk).toHaveBeenCalledWith({ parseAs: 'stream' });
    expect(mockDownloadResponseAsFile).toHaveBeenCalledWith(response, 'ci-hub-logs.log');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('shows an error toast when the log download fails', async () => {
    mockDownloadHubLogsSdk.mockResolvedValue({ response: new Response('failed', { status: 500 }) });

    render(<LogsContainer />);

    await userEvent.click(await screen.findByRole('button', { name: 'Download full logs' }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Hub log download failed with status 500');
    });
    expect(mockDownloadResponseAsFile).not.toHaveBeenCalled();
  });
});
