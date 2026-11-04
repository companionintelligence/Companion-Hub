import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/types/error.types';
import { AutoInstallRunnerButton } from '../auto-install-runner-button';

describe('AutoInstallRunnerButton', () => {
  it('opens a long reason on its last lines, where a failed command says why', async () => {
    const user = userEvent.setup();
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const onRun = vi.fn().mockRejectedValue(new Error('Hit:1 mirror\nE: Unable to locate package'));

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to locate package'));
    expect(screen.getByRole('alert').querySelector('.overflow-y-auto')?.scrollTop).toBe(900);
    scrollHeight.mockRestore();
  });

  it('uses the requested automatic action label and reports completion', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockResolvedValue(undefined);

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    expect(onRun).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Started'));
  });

  it('shows why the native runner failed', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue(new Error('Automatic Linux vLLM setup requires a working NVIDIA GPU.'));

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not start automatically'));
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic Linux vLLM setup requires a working NVIDIA GPU.');
  });

  it('still reports the failure when the runner gives no reason', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue(new Error(''));

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^Could not start automatically$/));
  });

  it('shows a reason the desktop app rejected with, which arrives as a plain string', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue('Inference runner setup task failed: task was cancelled');

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Inference runner setup task failed: task was cancelled'));
  });

  it('translates a reason that is an i18n key instead of printing the key', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue(new TranslatableError('INTERNAL_SERVER_ERROR'));

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Internal server error'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('INTERNAL_SERVER_ERROR');
  });

  it('reports the outcome under StrictMode, whose extra effect cleanup is not an unmount', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn().mockRejectedValue(new Error('Automatic Linux vLLM setup requires a working NVIDIA GPU.'));

    render(
      <StrictMode>
        <AutoInstallRunnerButton onRun={onRun} />
      </StrictMode>,
    );

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('requires a working NVIDIA GPU'));
  });
});
