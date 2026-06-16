import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { useAppContext } from '@/context/app-context';
import { apiFetch } from '@/lib/api-fetch';
import { checkForUpdates, getInstalledDesktopVersion, isTauri, performUpdate } from '@/lib/update-service';
import toast from 'react-hot-toast';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { GeneralActionsContainer } from './general-actions';

vi.mock('@/context/app-context', () => ({
  useAppContext: vi.fn(),
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/update-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/update-service')>('@/lib/update-service');
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    getInstalledDesktopVersion: vi.fn(),
    isTauri: vi.fn(),
    performUpdate: vi.fn(),
  };
});

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../components/update-repo-modal/update-repo-modal', () => ({
  UpdateRepoModal: () => <div>Update repo</div>,
}));

vi.mock('@/components/markdown/markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

const mockUseAppContext = vi.mocked(useAppContext);
const mockApiFetch = vi.mocked(apiFetch);
const mockCheckForUpdates = vi.mocked(checkForUpdates);
const mockGetInstalledDesktopVersion = vi.mocked(getInstalledDesktopVersion);
const mockIsTauri = vi.mocked(isTauri);
const mockPerformUpdate = vi.mocked(performUpdate);
const mockToastSuccess = vi.mocked(toast.success);

describe('GeneralActionsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAppContext.mockReturnValue({
      version: {
        current: '4.7.0',
        latest: '4.7.0',
        body: '',
        releases: [],
      },
      refreshAppContext: vi.fn(),
    } as ReturnType<typeof useAppContext>);

    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    } as Response);
  });

  it('shows the desktop version and linux download installer action in tauri mode', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });

    render(<GeneralActionsContainer />);

    expect(await screen.findByText('Current version: 0.2.23')).toBeInTheDocument();
    expect(screen.getByTestId('hub-update-btn')).toHaveTextContent('Download installer');
    expect(screen.queryByText('Current version: 4.7.0')).not.toBeInTheDocument();
  });

  it('surfaces the manual download message after opening the linux installer', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });
    mockPerformUpdate.mockResolvedValue({
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    });

    render(<GeneralActionsContainer />);

    await userEvent.click(await screen.findByTestId('hub-update-btn'));

    await waitFor(() => {
      expect(mockPerformUpdate).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Installer download opened in your browser.');
    });
    expect(screen.getByText('Installer download opened in your browser.')).toBeInTheDocument();
  });
});
