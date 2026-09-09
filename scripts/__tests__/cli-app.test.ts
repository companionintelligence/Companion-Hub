/**
 * `cihub app` — the two ways this surface lied to a script driving it.
 *
 * `app status <name>` and `app inspect <name>` printed "not found" and exited 0, so a deploy step
 * written as `cihub app status my-app && curl …` treated a container that was never created as
 * running. And `--tail=10` was invisible to an `indexOf('--tail')` lookup, so the command silently
 * showed 50 lines while echoing the number the operator asked for.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  runCapture: vi.fn(() => ({ stdout: '', ok: true })),
}));

vi.mock('../lib/cli-proc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-proc.js')>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));

import { runAppCommand } from '../lib/cli-app.js';

beforeEach(() => {
  process.exitCode = undefined;
  mocks.run.mockReset();
  mocks.runCapture.mockReset().mockReturnValue({ stdout: '', ok: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('app status', () => {
  it('fails when the named container does not exist', () => {
    runAppCommand(['status', 'ghost']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when the named container is there', () => {
    mocks.runCapture.mockReturnValue({ stdout: 'ghost\tUp 2 hours\t8080/tcp', ok: true });
    runAppCommand(['status', 'ghost']);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 when no name was given and the machine has no containers', () => {
    // Nothing was asked about, so nothing failed to be found — an empty machine is the answer.
    runAppCommand(['status']);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('app inspect', () => {
  it('fails when the container does not exist', () => {
    mocks.runCapture.mockReturnValue({ stdout: '', ok: false });
    runAppCommand(['inspect', 'ghost']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 for a container docker could inspect', () => {
    mocks.runCapture.mockReturnValue({ stdout: JSON.stringify([{ State: { Status: 'running' }, Config: { Image: 'nginx' } }]), ok: true });
    runAppCommand(['inspect', 'web']);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('app logs --tail', () => {
  const tailArg = () => {
    const args = mocks.run.mock.calls[0]?.[1] as string[];
    return args[args.indexOf('--tail') + 1];
  };

  it('reads the --tail=N form', () => {
    runAppCommand(['logs', 'web', '--tail=10']);
    expect(tailArg()).toBe('10');
  });

  it('reads the --tail N form', () => {
    runAppCommand(['logs', 'web', '--tail', '10']);
    expect(tailArg()).toBe('10');
  });

  it('defaults to 50 when --tail is absent', () => {
    runAppCommand(['logs', 'web']);
    expect(tailArg()).toBe('50');
  });
});
