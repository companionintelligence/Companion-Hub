import { describe, expect, it } from 'vitest';
import { extractConflictingHostPort, isDockerHostPortConflictError } from '../docker-port-errors';

/** Verbatim from Docker Engine 29.6 with a program on the host listening on 127.0.0.1:18789. */
const HOST_PROGRAM_LOOPBACK =
  'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint ci-openclaw_ci-marketplace-ci-openclaw-1 (a65f29c5292e1586261b7b1462ac406095a4de5aab1943177aa390fa496476dd): failed to bind host port 127.0.0.1:18789/tcp: address already in use';
/** Same host program, with the container publishing on every interface. */
const HOST_PROGRAM_ALL_INTERFACES =
  'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint hopeful_newton (e734d32a5b62555adba78c3683862437d6859a3feb7f285e255bbed9dc485e5a): failed to bind host port 0.0.0.0:18789/tcp: address already in use';
/** Verbatim from Docker Engine 29.6 with another container publishing 18798. */
const OTHER_CONTAINER =
  'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint affectionate_yalow (caad08c47c922ac47561f1a94a3780c65d40732921c2de21b77acf30ee158a84): Bind for 0.0.0.0:18798 failed: port is already allocated';

describe('docker-port-errors', () => {
  it('recognizes a port taken by a host program or by another container', () => {
    expect(isDockerHostPortConflictError(new Error(HOST_PROGRAM_LOOPBACK))).toBe(true);
    expect(isDockerHostPortConflictError(new Error(HOST_PROGRAM_ALL_INTERFACES))).toBe(true);
    expect(isDockerHostPortConflictError(new Error(OTHER_CONTAINER))).toBe(true);
    expect(isDockerHostPortConflictError('Ports are not available: exposing port TCP 0.0.0.0:8080 -> 0.0.0.0:0')).toBe(true);
  });

  it('does not take other compose failures for a port conflict', () => {
    expect(isDockerHostPortConflictError(new Error('networks have overlapping IPv4'))).toBe(false);
    expect(isDockerHostPortConflictError(new Error('pull access denied for ghcr.io/example/app, repository does not exist'))).toBe(false);
    expect(isDockerHostPortConflictError(new Error('Bind for 0.0.0.0:80 failed: permission denied'))).toBe(false);
  });

  it('reads the host port from each wording', () => {
    expect(extractConflictingHostPort(new Error(HOST_PROGRAM_LOOPBACK))).toBe(18789);
    expect(extractConflictingHostPort(new Error(HOST_PROGRAM_ALL_INTERFACES))).toBe(18789);
    expect(extractConflictingHostPort(new Error(OTHER_CONTAINER))).toBe(18798);
    expect(extractConflictingHostPort('failed to bind host port for 0.0.0.0:8080:172.17.0.2:80/tcp: address already in use')).toBe(8080);
    expect(
      extractConflictingHostPort(
        'Ports are not available: exposing port TCP 0.0.0.0:8080 -> 0.0.0.0:0: listen tcp 0.0.0.0:8080: bind: address already in use',
      ),
    ).toBe(8080);
    expect(extractConflictingHostPort('Error starting userland proxy: listen tcp4 0.0.0.0:3000: bind: address already in use')).toBe(3000);
  });

  it('reads the port after an IPv6 address', () => {
    expect(extractConflictingHostPort('failed to bind host port [::]:18789/tcp: address already in use')).toBe(18789);
    expect(extractConflictingHostPort('Bind for :::5432 failed: port is already allocated')).toBe(5432);
    expect(extractConflictingHostPort('Bind for [::1]:8642 failed: port is already allocated')).toBe(8642);
  });

  it('names no port when the message carries none', () => {
    expect(extractConflictingHostPort(new Error('address already in use'))).toBeUndefined();
    expect(extractConflictingHostPort(new Error('networks have overlapping IPv4'))).toBeUndefined();
    expect(extractConflictingHostPort(undefined)).toBeUndefined();
  });
});
