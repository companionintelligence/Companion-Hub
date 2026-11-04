import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AutoInstallRunnerButton } from '../auto-install-runner-button';

describe('AutoInstallRunnerButton', () => {
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
    const onRun = vi.fn().mockRejectedValue('no reason');

    render(<AutoInstallRunnerButton onRun={onRun} />);

    await user.click(screen.getByRole('button', { name: 'Run this automatically' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^Could not start automatically$/));
  });
});
