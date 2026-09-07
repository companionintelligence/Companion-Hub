import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * Lock-step guard for the Hub container's access to the host Tailscale CLI + socket.
 *
 * `TailscaleService.resolveStrategy()` reaches tailscaled one of two ways: the host binary
 * plus the host socket, or the `hub-tailscale` sidecar. The sidecar sits behind the
 * `private-vpn` profile and needs `TAILSCALE_AUTHKEY`, so on an ordinary Tailscale host it
 * is absent — leaving the host path as the only route. When neither is reachable the Hub
 * reports `notInstalled`, `/inference/pool/identify` answers `nodeFqdn: null`, and Hub Pool
 * pairing cannot complete at all: a peer has no address to dial.
 *
 * Both shipped copies of the compose file must therefore mount both paths, and the socket
 * must be READ-WRITE — `isSocketAvailable()` probes it with `R_OK | W_OK`, so a `:ro` mount
 * reads as correct and silently disables pooling. That failure mode is the reason this file
 * exists.
 */
const REPO_ROOT = path.join(__dirname, '../../../..');

const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

describe('Hub container Tailscale access (Hub Pool nodeFqdn)', () => {
  it.each(COMPOSE_COPIES)('%s mounts the host tailscaled socket read-write', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    const line = content.split('\n').find((candidate) => candidate.includes(':/var/run/tailscale'));
    expect(line, `no /var/run/tailscale mount in ${relativePath}`).toBeTruthy();
    // A trailing `:ro` would pass a naive "is it mounted" check and still break pooling.
    expect(line?.trimEnd().endsWith(':ro'), `${relativePath} mounts the tailscaled socket read-only`).toBe(false);
  });

  it.each(COMPOSE_COPIES)('%s mounts the host tailscale binary', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    expect(content).toContain(':/usr/bin/tailscale');
  });
});
