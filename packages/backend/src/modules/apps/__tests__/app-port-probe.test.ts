import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeAppPort } from '../app-port-probe';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('probeAppPort', () => {
  it('reports an HTTP answer of any status as answered', async () => {
    const port = await listen(
      http.createServer((_request, response) => {
        response.statusCode = 503;
        response.end('loading model');
      }),
    );

    await expect(probeAppPort('127.0.0.1', port, 2_000)).resolves.toBe('answered');
  });

  it('reports a port nobody listens on as refused', async () => {
    const port = await listen(net.createServer());
    await new Promise((resolve) => servers.pop()?.close(resolve));

    await expect(probeAppPort('127.0.0.1', port, 2_000)).resolves.toBe('refused');
  });

  it('reports a connection that is taken and never answered as silent', async () => {
    const port = await listen(net.createServer(() => {}));

    await expect(probeAppPort('127.0.0.1', port, 300)).resolves.toBe('silent');
  });

  it('reports bytes of another protocol as answered', async () => {
    const port = await listen(net.createServer((socket) => socket.write('-ERR unknown command\r\n')));

    await expect(probeAppPort('127.0.0.1', port, 2_000)).resolves.toBe('answered');
  });

  // A one-byte length prefix reads `G` as a 71-byte message. The server waits for all of it before it
  // says anything, so a request shorter than that looked like a hung app.
  it('reports a server that frames messages with a one-byte length as answered', async () => {
    const port = await listen(
      net.createServer((socket) => {
        let received = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          received = Buffer.concat([received, chunk]);
          const length = received[0] ?? Number.POSITIVE_INFINITY;
          if (received.length > length) {
            socket.destroy();
          }
        });
      }),
    );

    await expect(probeAppPort('127.0.0.1', port, 1_000)).resolves.toBe('answered');
  });

  it('reports a server that closes the connection as answered', async () => {
    const port = await listen(net.createServer((socket) => socket.destroy()));

    await expect(probeAppPort('127.0.0.1', port, 2_000)).resolves.toBe('answered');
  });

  it('reports an address it cannot connect to as unreachable', async () => {
    // TEST-NET-1 (RFC 5737) routes nowhere: the connect either fails at once or never completes.
    await expect(probeAppPort('192.0.2.1', 80, 300)).resolves.toBe('unreachable');
  });
});
