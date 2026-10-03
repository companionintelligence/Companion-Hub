import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
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

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/components/logs-terminal/logs-terminal', () => ({
  LogsTerminal: ({ toolbarActions }: { toolbarActions?: ReactNode }) => (
    <div data-testid="logs-terminal">
      <div data-testid="logs-terminal-toolbar">{toolbarActions}</div>
    </div>
  ),
}));

describe('LogsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads full hub logs from the backend endpoint', async () => {
    const response = new Response('hub logs', { status: 200 });
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

  it('says the log stream is connecting until it opens', () => {
    render(<LogsContainer />);

    expect(screen.getByTestId('logs-stream-status')).toHaveTextContent('SETTINGS_LOGS_CONNECTING');
    expect(screen.queryByTestId('logs-terminal')).not.toBeInTheDocument();
  });

  it('says the log stream is empty after it opens with no lines', () => {
    render(<LogsContainer />);

    act(() => {
      mockUseSSE.mock.calls[0]?.[0].onOpen();
    });

    expect(screen.getByTestId('logs-stream-status')).toHaveTextContent('SETTINGS_LOGS_EMPTY');
    expect(screen.queryByTestId('logs-terminal')).not.toBeInTheDocument();
  });

  it('shows the terminal once a log line arrives', async () => {
    render(<LogsContainer />);

    act(() => {
      const stream = mockUseSSE.mock.calls[0]?.[0];
      stream.onOpen();
      stream.onEvent({ event: 'newLogs', lines: ['hub ready'] });
    });

    expect(await screen.findByTestId('logs-terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('logs-stream-status')).not.toBeInTheDocument();
  });

  it('says the log stream failed and retries it', async () => {
    render(<LogsContainer />);

    act(() => {
      mockUseSSE.mock.calls[0]?.[0].onError();
    });

    expect(screen.getByTestId('logs-stream-error')).toHaveTextContent('SETTINGS_LOGS_STREAM_ERROR');
    expect(screen.queryByTestId('logs-terminal')).not.toBeInTheDocument();

    const callsBeforeRetry = mockUseSSE.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'COMMON_RETRY' }));

    expect(screen.getByTestId('logs-stream-status')).toHaveTextContent('SETTINGS_LOGS_CONNECTING');
    // `useSSE` runs on each render; Retry remounts the stream, so it runs again.
    expect(mockUseSSE.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});
