import { describe, expect, it } from 'vitest';
import { appComposeEnvironment } from '../app-compose-environment';

describe('appComposeEnvironment', () => {
  const hub: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/node',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    DOCKER_CONFIG: '/home/node/.docker',
    https_proxy: 'http://proxy.lan:3128',
    NO_PROXY: 'localhost',
    JWT_SECRET: 'hub-signing-key',
    CI_HUB_FORWARD_AUTH_SECRET: 'forward-auth',
    POSTGRES_PASSWORD: 'db',
    RABBITMQ_PASSWORD: 'broker',
    TAILSCALE_AUTHKEY: 'tskey',
    DOMAIN: 'example.com',
  };

  it('keeps what the Docker CLI needs to find the plugin, the engine and a registry', () => {
    expect(appComposeEnvironment(hub)).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/node',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      DOCKER_CONFIG: '/home/node/.docker',
      https_proxy: 'http://proxy.lan:3128',
      NO_PROXY: 'localhost',
    });
  });

  it('leaves out every Hub secret, so `${JWT_SECRET}` in an app compose expands to nothing', () => {
    const env = appComposeEnvironment(hub);
    for (const name of ['JWT_SECRET', 'CI_HUB_FORWARD_AUTH_SECRET', 'POSTGRES_PASSWORD', 'RABBITMQ_PASSWORD', 'TAILSCALE_AUTHKEY']) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('leaves out values the app gets from its own env file, which the process environment would override', () => {
    expect(appComposeEnvironment(hub)).not.toHaveProperty('DOMAIN');
  });

  it("matches Windows' mixed-case names", () => {
    expect(appComposeEnvironment({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe' })).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'cmd.exe',
    });
  });
});
