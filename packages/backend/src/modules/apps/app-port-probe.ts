import http from 'node:http';

/**
 * What an app's own port did with one HTTP request.
 *
 * - `answered`: it sent something back, an HTTP response of any status or bytes of another protocol.
 * - `refused`: nothing listens on the port.
 * - `silent`: the connection opened but nothing came back before the timeout, which is how a hung
 *   app looks: the kernel accepts the connection for it, and the app never reads the request.
 * - `unreachable`: the connection never opened, so this probe can't tell anything about the app. A
 *   backend that runs outside Docker on a host with no route to the container network sees this.
 */
export type AppPortProbeResult = 'answered' | 'refused' | 'silent' | 'unreachable';

/**
 * Sends `GET /` to `host:port` and reports how the port behaved. Never throws.
 */
export function probeAppPort(host: string, port: number, timeoutMs: number): Promise<AppPortProbeResult> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;

    const request = http.get({ host, port, path: '/', agent: false, headers: { Connection: 'close' } });

    const finish = (result: AppPortProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(connected ? 'silent' : 'unreachable'), timeoutMs);

    request.on('socket', (socket) => {
      socket.once('connect', () => {
        connected = true;
      });
    });
    request.on('response', (response) => {
      response.resume();
      finish('answered');
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish('refused');
        return;
      }
      // After the connection opened, an error means the other side did something: closed it, reset
      // it, or answered in another protocol (a parse error). Before, the address was out of reach.
      finish(connected ? 'answered' : 'unreachable');
    });
  });
}
