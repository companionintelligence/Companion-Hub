import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPortAvailable, isPortAvailableViaTcpBind } from '../port-availability';

describe('port-availability', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('reports occupied ports via TCP bind probe', async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected numeric port');
    }

    expect(isPortAvailableViaTcpBind(address.port)).toBe(false);
    expect(isPortAvailable(address.port)).toBe(false);
  });

  it('reports free ports via TCP bind probe', () => {
    expect(isPortAvailableViaTcpBind(59999)).toBe(true);
    expect(isPortAvailable(59999)).toBe(true);
  });
});
