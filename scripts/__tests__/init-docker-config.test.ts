import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The container-safe Docker config `cihub setup` writes to `<ROOT_FOLDER_HOST>/.docker/config.json`,
 * which the Hub reads as DOCKER_CONFIG=/data/.docker for its own compose calls. It must keep what
 * works in the container and drop what only works on the host, the same way the desktop app's copy
 * does (hub_manager/compose.rs, `generate_container_docker_config`).
 */
const scratch = mkdtempSync(path.join(tmpdir(), 'init-docker-config-'));
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const os = { ...actual, homedir: () => home.dir };
  return { ...os, default: os };
});

home.dir = path.join(scratch, 'home');
const { containerSafeDockerConfig, initDockerConfig } = await import('../init-docker-config');

const PROXIES = {
  default: {
    httpProxy: 'http://proxy.example:3128',
    httpsProxy: 'http://proxy.example:3128',
    noProxy: 'localhost,127.0.0.1,.example.internal',
  },
  'tcp://docker.example:2376': { httpsProxy: 'http://other-proxy.example:3128' },
};

const HOST_CONFIG = {
  auths: { 'https://index.docker.io/v1/': { auth: 'dXNlcjpwYXNz' }, 'ghcr.io': {} },
  proxies: PROXIES,
  credsStore: 'desktop',
  credHelpers: { 'ghcr.io': 'desktop', 'registry.example': 'ecr-login' },
  currentContext: 'desktop-linux',
  plugins: { debug: { enabled: true } },
  features: { hooks: 'true' },
  hooks: { x: {} },
  aliases: { builder: 'buildx' },
  experimental: 'enabled',
};

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('containerSafeDockerConfig', () => {
  // Docker Compose sets HTTPS_PROXY, NO_PROXY and the rest from `proxies` in every container it
  // creates, so without it the Hub's self-update and app installs lost the host's proxy (#1765).
  it('keeps the proxy settings as they are, and still drops what only works on the host', () => {
    expect(containerSafeDockerConfig(HOST_CONFIG)).toEqual({
      auths: { 'https://index.docker.io/v1/': { auth: 'dXNlcjpwYXNz' } },
      proxies: PROXIES,
      credHelpers: { 'registry.example': 'ecr-login' },
    });
  });

  it('leaves out a proxies entry the Docker CLI cannot read, which would cost it the auths too', () => {
    const auths = { 'registry.example': { auth: 'dXNlcjpwYXNz' } };
    for (const proxies of ['http://proxy.example:3128', ['http://proxy.example:3128'], null]) {
      expect(containerSafeDockerConfig({ auths, proxies })).toEqual({ auths });
    }
  });
});

describe('initDockerConfig', () => {
  it('writes the proxies into the config the Hub container reads, readable by its owner only', async () => {
    mkdirSync(path.join(home.dir, '.docker'), { recursive: true });
    writeFileSync(path.join(home.dir, '.docker', 'config.json'), JSON.stringify({ proxies: PROXIES, currentContext: 'desktop-linux' }));
    const root = path.join(scratch, 'root');
    vi.stubEnv('ENV_FILE', path.join(scratch, 'no-such.env'));
    vi.stubEnv('ROOT_FOLDER_HOST', root);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await initDockerConfig();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }

    const written = path.join(root, '.docker', 'config.json');
    expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual({ proxies: PROXIES });
    if (process.platform !== 'win32') expect(statSync(written).mode & 0o777).toBe(0o600);
  });
});
