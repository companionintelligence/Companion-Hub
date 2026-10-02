import { describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { assertHubCanReachPort, hubPortProbeHost } from '../port-expose-reachability';

vi.mock('@/modules/inference/backends/host-url.util', () => ({
  detectHubContainer: () => true,
}));

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
