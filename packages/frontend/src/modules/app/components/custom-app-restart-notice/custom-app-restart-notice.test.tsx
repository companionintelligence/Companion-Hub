import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { CustomAppRestartNotice } from './custom-app-restart-notice';

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({}),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  restartAppMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const info = { id: 'family-photos', name: 'Family Photos', urn: 'family-photos:_user' } as AppInfo;
const app = (status: AppDetails['status'], pendingRestart: boolean) => ({ id: 1, status, pendingRestart }) as unknown as AppDetails;

describe('CustomAppRestartNotice', () => {
  // A save to a running custom app only rewrites its compose file (#2421).
  it('says a running app owes a restart and opens the Restart dialog', async () => {
    const user = userEvent.setup();
    render(<CustomAppRestartNotice info={info} app={app('running', true)} canRestart />);

    const notice = screen.getByTestId('custom-app-restart-notice');
    expect(notice).toHaveTextContent('Restart to use the saved changes');
    expect(notice).toHaveTextContent('Family Photos keeps running with its old configuration until it restarts.');
    expect(notice).toHaveAttribute('role', 'status');

    await user.click(screen.getByRole('button', { name: 'Restart' }));

    expect(screen.getByRole('dialog', { name: 'Restart Family Photos?' })).toBeInTheDocument();
  });

  it('still says so to someone who may not restart the app, without the button', () => {
    render(<CustomAppRestartNotice info={info} app={app('running', true)} canRestart={false} />);

    expect(screen.getByTestId('custom-app-restart-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });

  it.each([
    ['running with nothing owed', app('running', false)],
    ['stopped, whose next start reads the new file', app('stopped', true)],
    ['not installed', null],
  ])('shows nothing for an app %s', (_case, record) => {
    render(<CustomAppRestartNotice info={info} app={record} canRestart />);

    expect(screen.queryByTestId('custom-app-restart-notice')).not.toBeInTheDocument();
  });
});
