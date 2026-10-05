import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '../docker.service';

/*
 * socktainer exposes Apple's `container` runtime through a Docker-compatible socket. It answers
 * `network connect` and `disconnect` with success and changes nothing, because Virtualization.framework
 * cannot hot-plug a NIC. Hub joins itself to app networks and Traefik to the edge network that way, so
 * on this engine those calls must not run: a logged "Attached …" would be a join that never happened.
 */

const APP_URN = 'ci-memory:ci-marketplace' as never;
const SOCKTAINER_VERSION = { Platform: { Name: 'socktainer' }, Components: [{ Name: 'socktainer', Version: '1.5.0' }] };
const DOCKER_VERSION = { Platform: { Name: 'Docker Engine - Community' }, Components: [{ Name: 'Engine' }] };

const runningHub = { Name: '/ci-hub', State: { Running: true }, NetworkSettings: { Networks: { 'ci-hub_network': {} } } };

describe('DockerService on Apple container (socktainer)', () => {
  const setup = (version: unknown | Error, containers: Record<string, unknown> = { 'ci-hub': runningHub }) => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const docker = {
      version: version instanceof Error ? vi.fn().mockRejectedValue(version) : vi.fn().mockResolvedValue(version),
      listNetworks: vi.fn().mockResolvedValue([{ Id: 'app-net', Name: 'ci-memory_ci-marketplace_network', Labels: {} }]),
      getNetwork: vi.fn(() => ({
        connect,
        disconnect,
        inspect: vi.fn().mockResolvedValue({ Internal: false }),
      })),
      getContainer: vi.fn((name: string) => ({
        inspect: containers[name] ? vi.fn().mockResolvedValue(containers[name]) : vi.fn().mockRejectedValue(new Error('no such container')),
      })),
    };
    const logger = mock<LoggerService>();
    const dockerReadFacade = { getComposeProjectName: (appUrn: string) => String(appUrn).replace(':', '_') };
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), docker as never, dockerReadFacade as never);
    return { service, docker, connect, disconnect, logger };
  };

  describe('engine detection', () => {
    it('detects socktainer from /version and warns once about what degrades', async () => {
      const { service, docker, logger } = setup(SOCKTAINER_VERSION);

      await expect(service.isAppleContainerEngine()).resolves.toBe(true);
      await expect(service.isAppleContainerEngine()).resolves.toBe(true);

      expect(docker.version).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Apple container (socktainer): experimental'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 GiB'));
    });

    it('is false, and silent, on Docker', async () => {
      const { service, logger } = setup(DOCKER_VERSION);

      await expect(service.isAppleContainerEngine()).resolves.toBe(false);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not remember an unreachable daemon as "Docker"', async () => {
      const { service, docker } = setup(new Error('connect ENOENT /var/run/docker.sock'));
      await expect(service.isAppleContainerEngine()).resolves.toBe(false);

      docker.version.mockResolvedValue(SOCKTAINER_VERSION);

      await expect(service.isAppleContainerEngine()).resolves.toBe(true);
      expect(docker.version).toHaveBeenCalledTimes(2);
    });

    it('treats a double with no version() as Docker rather than throwing', async () => {
      const { service, docker } = setup(DOCKER_VERSION);
      (docker as { version?: unknown }).version = undefined;

      await expect(service.isAppleContainerEngine()).resolves.toBe(false);
    });
  });

  describe('Hub to app networks', () => {
    it('does not call network connect, and says what that costs, once', async () => {
      const { service, connect, logger } = setup(SOCKTAINER_VERSION);

      await service.attachHubToAppNetworks(APP_URN);
      await service.attachHubToAppNetworks(APP_URN);
      await service.ensureHubOnAppNetworks();

      expect(connect).not.toHaveBeenCalled();
      const gapWarnings = logger.warn.mock.calls.filter(([message]) => String(message).startsWith('Not attaching the Hub to app networks'));
      expect(gapWarnings).toHaveLength(1);
      expect(gapWarnings[0]?.[0]).toContain('cannot resolve ci-hub');
      // No false success.
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Attached'));
    });

    it('leaves nothing to detach, so it does not call network disconnect', async () => {
      const { service, disconnect, docker } = setup(SOCKTAINER_VERSION);

      await service.detachHubFromAppNetworks(APP_URN);

      expect(disconnect).not.toHaveBeenCalled();
      expect(docker.listNetworks).not.toHaveBeenCalled();
    });

    it('still joins the app network on Docker', async () => {
      const { service, connect } = setup(DOCKER_VERSION);

      await service.attachHubToAppNetworks(APP_URN);

      expect(connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Traefik on the edge network', () => {
    const traefik = (networks: Record<string, unknown>) => ({ Name: '/traefik', State: { Running: true }, NetworkSettings: { Networks: networks } });

    it('reports a Traefik that predates the edge network as failed, with the fix, instead of attaching it', async () => {
      const { service, connect, logger } = setup(SOCKTAINER_VERSION, { traefik: traefik({ 'ci-hub_network': {} }) });

      await expect(service.ensureTraefikOnEdgeNetwork()).resolves.toBe('failed');

      expect(connect).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cihub up'));
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Attached'));
    });

    it('is still present when a full up already put Traefik on the edge network', async () => {
      const { service, connect } = setup(SOCKTAINER_VERSION, { traefik: traefik({ 'ci-hub_edge': {} }) });

      await expect(service.ensureTraefikOnEdgeNetwork()).resolves.toBe('present');

      expect(connect).not.toHaveBeenCalled();
    });
  });
});
