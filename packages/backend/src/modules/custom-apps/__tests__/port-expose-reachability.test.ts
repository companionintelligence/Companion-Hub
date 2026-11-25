import { describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { lookup } from 'node:dns/promises';
import { assertHubCanReachPort, hubPortProbeAddress, hubPortProbeHost } from '../port-expose-reachability';

vi.mock('@/modules/inference/backends/host-url.util', () => ({
  detectHubContainer: () => true,
}));

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('assertHubCanReachPort', () => {
  it('probes host.docker.internal from inside the Hub container', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);

    await assertHubCanReachPort(18765, connect);

    expect(hubPortProbeHost()).toBe('host.docker.internal');
    expect(connect).toHaveBeenCalledWith('host.docker.internal', 18765);
  });

  it('refuses a port the Hub cannot open, and does not use a caller-supplied host', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const error = await assertHubCanReachPort(18765, connect).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TranslatableError);
    expect(error).toMatchObject({ message: 'PORT_EXPOSE_PORT_UNREACHABLE' });
    expect((error as TranslatableError).getResponse()).toMatchObject({
      intlParams: { port: '18765', host: 'host.docker.internal' },
    });
    expect(connect).toHaveBeenCalledWith('host.docker.internal', 18765);
  });

  it('rejects a port outside the published range before connecting', async () => {
    const connect = vi.fn();

    await expect(assertHubCanReachPort(80, connect)).rejects.toBeInstanceOf(TranslatableError);
    await expect(assertHubCanReachPort(80, connect)).rejects.toMatchObject({ message: 'PORT_EXPOSE_PORT_INVALID' });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('hubPortProbeAddress', () => {
  it("gives the address host.docker.internal has in the Hub's container, for a dialer outside it", async () => {
    vi.mocked(lookup).mockResolvedValueOnce({ address: '172.17.0.1', family: 4 } as never);

    await expect(hubPortProbeAddress(true)).resolves.toBe('172.17.0.1');
    expect(lookup).toHaveBeenCalledWith('host.docker.internal', { family: 4 });
  });

  it("is null when host.docker.internal doesn't resolve", async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND host.docker.internal'));

    await expect(hubPortProbeAddress(true)).resolves.toBeNull();
  });

  it('is loopback, without a lookup, for a Hub that runs on the host', async () => {
    vi.mocked(lookup).mockClear();

    await expect(hubPortProbeAddress(false)).resolves.toBe('127.0.0.1');
    expect(lookup).not.toHaveBeenCalled();
  });
});
