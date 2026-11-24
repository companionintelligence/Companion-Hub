import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import {
  HOST_DOCKER_BASE_ENV_KEYS,
  hostDockerArgvRefusal,
  hostDockerEnv,
  McpStdioLaunchPolicy,
  McpStdioLaunchRefused,
} from '../mcp-stdio-launch-policy';

/** The two host_docker listings the official store ships today, verbatim. */
const GITHUB_MCP = ['docker', 'run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v0.6.0'];
const UNITY_MCP = [
  'docker',
  'run',
  '-i',
  '--rm',
  '-e',
  'MCP_PLUGIN_CLIENT_TRANSPORT=stdio',
  '-p',
  '8080:8080',
  'ivanmurzakdev/unity-mcp-server:0.76.1',
];

describe('hostDockerArgvRefusal', () => {
  it.each([
    ['github-mcp', GITHUB_MCP],
    ['unity-mcp', UNITY_MCP],
    ['--env= form', ['docker', 'run', '-i', '--env=FOO=bar', 'alpine:3']],
    ['container argv after the image is the container’s own', ['docker', 'run', '-i', 'alpine:3', 'sh', '-c', '--privileged']],
  ])('allows %s', (_label, argv) => {
    expect(hostDockerArgvRefusal(argv)).toBeNull();
  });

  it.each([
    ['a shell', ['sh', '-c', 'docker run --privileged -v /:/h alpine chroot /h']],
    ['docker with a global flag', ['docker', '--host', 'tcp://evil:2375', 'run', 'alpine']],
    ['docker exec', ['docker', 'exec', 'ci-hub', 'cat', '/data/.env']],
    ['--privileged', ['docker', 'run', '--privileged', 'alpine']],
    ['a bind mount', ['docker', 'run', '-v', '/:/host', 'alpine']],
    ['--volume=', ['docker', 'run', '--volume=/:/host', 'alpine']],
    ['--mount', ['docker', 'run', '--mount', 'type=bind,src=/,dst=/h', 'alpine']],
    ['host network', ['docker', 'run', '--network', 'host', 'alpine']],
    ['--pid=host', ['docker', 'run', '--pid=host', 'alpine']],
    ['--cap-add', ['docker', 'run', '--cap-add', 'SYS_ADMIN', 'alpine']],
    ['--env-file reading a Hub file', ['docker', 'run', '--env-file', '/data/.env', 'alpine']],
    ['--entrypoint', ['docker', 'run', '--entrypoint', 'sh', 'alpine']],
    ['-e with a non-name', ['docker', 'run', '-e', '-v', 'alpine']],
    ['-p bound to an address', ['docker', 'run', '-p', '0.0.0.0:80:80', 'alpine']],
    ['a value on a valueless flag', ['docker', 'run', '--rm=false', 'alpine']],
    ['no image', ['docker', 'run', '-i', '--rm']],
    ['a dangling -e', ['docker', 'run', '-e']],
  ])('refuses %s', (_label, argv) => {
    expect(hostDockerArgvRefusal(argv)).not.toBeNull();
  });
});

describe('hostDockerEnv', () => {
  const hub = { PATH: '/usr/bin', HOME: '/root', JWT_SECRET: 'hub-secret', POSTGRES_PASSWORD: 'pg', DOCKER_HOST: 'unix:///var/run/docker.sock' };

  it('passes the app’s own settings and only the Docker CLI’s Hub variables', () => {
    const env = hostDockerEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }, hub);
    expect(env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x', PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock' });
    expect(Object.keys(env)).not.toContain('JWT_SECRET');
    for (const key of Object.keys(env)) {
      expect(key === 'GITHUB_PERSONAL_ACCESS_TOKEN' || (HOST_DOCKER_BASE_ENV_KEYS as readonly string[]).includes(key)).toBe(true);
    }
  });

  it('never lets app.env choose the binary, the loader or the daemon', () => {
    const env = hostDockerEnv(
      { PATH: '/data/apps/evil/bin', LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x', DOCKER_HOST: 'tcp://evil:2375', DOCKER_CONFIG: '/x' },
      hub,
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    expect(env).not.toHaveProperty('LD_PRELOAD');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('DOCKER_CONFIG');
  });
});

describe('McpStdioLaunchPolicy', () => {
  let dockerRead: MockProxy<DockerReadFacade>;
  let policy: McpStdioLaunchPolicy;

  beforeEach(() => {
    dockerRead = mock<DockerReadFacade>();
    policy = new McpStdioLaunchPolicy(dockerRead);
  });

  describe('host_docker', () => {
    it('allows an official-store listing that is a plain docker run', async () => {
      await expect(
        policy.assertAllowed('github-mcp:ci-marketplace' as AppUrn, { launch: 'host_docker', command: GITHUB_MCP }),
      ).resolves.toBeUndefined();
    });

    it('refuses the same listing from any other store', async () => {
      await expect(policy.assertAllowed('github-mcp:some-store' as AppUrn, { launch: 'host_docker', command: GITHUB_MCP })).rejects.toBeInstanceOf(
        McpStdioLaunchRefused,
      );
    });

    it('refuses a custom app', async () => {
      await expect(policy.assertAllowed('mine:_user' as AppUrn, { launch: 'host_docker', command: GITHUB_MCP })).rejects.toBeInstanceOf(
        McpStdioLaunchRefused,
      );
    });

    it('refuses an official-store listing that escapes the allowlist', async () => {
      const argv = ['docker', 'run', '--privileged', '-v', '/:/h', 'alpine'];
      await expect(policy.assertAllowed('github-mcp:ci-marketplace' as AppUrn, { launch: 'host_docker', command: argv })).rejects.toBeInstanceOf(
        McpStdioLaunchRefused,
      );
    });
  });

  describe('container_exec', () => {
    it('allows a container of the app’s own compose project', async () => {
      dockerRead.readContainerLabel.mockResolvedValue({ found: true, value: 'nextcloud_some-store' });
      await expect(
        policy.assertAllowed('nextcloud:some-store' as AppUrn, {
          launch: 'container_exec',
          command: ['mcp'],
          container: 'nextcloud_some-store-nextcloud-1',
        }),
      ).resolves.toBeUndefined();
      expect(dockerRead.readContainerLabel).toHaveBeenCalledWith('nextcloud_some-store-nextcloud-1', 'com.docker.compose.project');
    });

    it.each([
      ['CI Memory’s api container', 'ci-memory_ci-marketplace-api-1', 'ci-memory_ci-marketplace'],
      ['the Hub itself', 'ci-hub', 'ci-hub'],
      // `ci-memory:ci` + service `marketplace-api` computes the same NAME as CI Memory's api container.
      ['a name collision across projects', 'ci-memory_ci-marketplace-api-1', 'ci-memory_ci-marketplace'],
    ])('refuses %s', async (_label, container, project) => {
      dockerRead.readContainerLabel.mockResolvedValue({ found: true, value: project });
      await expect(policy.assertAllowed('ci-memory:ci' as AppUrn, { launch: 'container_exec', command: ['sh'], container })).rejects.toBeInstanceOf(
        McpStdioLaunchRefused,
      );
    });

    it.each([
      ['missing', { found: false } as const],
      ['unlabelled', { found: true, value: null } as const],
      ['Docker unreachable', null],
    ])('refuses a container whose project cannot be read (%s)', async (_label, result) => {
      dockerRead.readContainerLabel.mockResolvedValue(result);
      await expect(
        policy.assertAllowed('app:store' as AppUrn, { launch: 'container_exec', command: ['mcp'], container: 'app_store-app-1' }),
      ).rejects.toBeInstanceOf(McpStdioLaunchRefused);
    });

    it('refuses a container name docker would read as a flag', async () => {
      await expect(
        policy.assertAllowed('app:store' as AppUrn, { launch: 'container_exec', command: ['mcp'], container: '--privileged' }),
      ).rejects.toBeInstanceOf(McpStdioLaunchRefused);
      expect(dockerRead.readContainerLabel).not.toHaveBeenCalled();
    });
  });
});
