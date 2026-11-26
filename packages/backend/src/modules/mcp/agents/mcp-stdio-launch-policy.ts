import { Injectable } from '@nestjs/common';
import { hostDockerArgvRefusal } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { isOfficialStoreApp } from '@/modules/apps/official-store.predicate';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import type { StdioSpawnSpec } from './mcp-stdio-session';

/**
 * What an app's MCP listing may make the Hub run.
 *
 * A stdio listing is a command line taken from the app's manifest (`config.json` `mcp`, or
 * `agents.mcp`), and the Hub runs it itself: `host_docker` spawns the argv in the Hub container,
 * which holds the Docker socket and every Hub secret, and `container_exec` runs
 * `docker exec -i <container> …` against a container the listing may name. Both used to take the
 * manifest at its word, so any app from any store could run `sh -c …` as the Hub, or `docker exec`
 * into CI Memory's api container, on the probe that follows every install.
 *
 * The rules, each checked on every spawn (not at install, so an app updated in place is held to
 * them too):
 *
 * - `host_docker` only for apps installed from the official store (install provenance, the same
 *   gate as {@link isOfficialStoreApp}), and only as `docker run` with the flags real listings use
 *   (see `HOST_DOCKER_RUN_FLAGS` in @ci-hub/common's mcp-host-docker.ts). Everything after the image is the container's own argv.
 * - `container_exec` only into a container Compose created for THIS app's project. Checked by the
 *   container's `com.docker.compose.project` label, not its name: names are `<project>-<service>-N`
 *   and both halves may contain `-`, so a name alone cannot say which project it belongs to.
 * - The spawned process gets this app's own app.env and the few Hub variables the Docker CLI needs
 *   ({@link HOST_DOCKER_BASE_ENV_KEYS}), never the Hub's whole environment. A bare `-e NAME` reads
 *   NAME from that environment, so it can only copy the app's own settings into the container.
 */

/**
 * Hub variables a `docker run` needs to reach the daemon. Taken from the Hub, and set AFTER app.env
 * so an app cannot point PATH at a binary in its own data directory or DOCKER_HOST at a daemon of
 * its choosing.
 */
export const HOST_DOCKER_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
] as const;

/** app.env keys that change how a process loads code or which binary runs; never passed through. */
const APP_ENV_KEY_DENIED = /^(PATH|HOME|LD_.*|DYLD_.*|NODE_OPTIONS|DOCKER_.*|BUILDKIT_.*|COMPOSE_.*)$/;

export { hostDockerArgvRefusal };

export class McpStdioLaunchRefused extends Error {
  constructor(appUrn: AppUrn, reason: string) {
    super(`MCP stdio server for ${appUrn} refused: ${reason}`);
    this.name = 'McpStdioLaunchRefused';
  }
}

/** The environment a host_docker process runs with: this app's settings, then the Docker CLI's own. */
export function hostDockerEnv(appEnv: Record<string, string>, hubEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(appEnv)) {
    if (!APP_ENV_KEY_DENIED.test(key)) env[key] = value;
  }
  for (const key of HOST_DOCKER_BASE_ENV_KEYS) {
    const value = hubEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The Compose project the Hub runs an app under: `<appName>_<storeSlug>`. */
export function composeProjectForApp(appUrn: AppUrn): string {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  return `${appName}_${appStoreId}`;
}

@Injectable()
export class McpStdioLaunchPolicy {
  constructor(private readonly dockerRead: DockerReadFacade) {}

  /** Throws {@link McpStdioLaunchRefused} unless `spec` is something this app may make the Hub run. */
  async assertAllowed(appUrn: AppUrn, spec: StdioSpawnSpec): Promise<void> {
    if (spec.launch === 'host_docker') {
      if (!isOfficialStoreApp({ urn: appUrn })) {
        throw new McpStdioLaunchRefused(appUrn, 'host_docker is only allowed for apps from the official store');
      }
      const refusal = hostDockerArgvRefusal(spec.command);
      if (refusal) throw new McpStdioLaunchRefused(appUrn, refusal);
      return;
    }

    const container = spec.container;
    if (!container || container.startsWith('-')) throw new McpStdioLaunchRefused(appUrn, 'no container to exec into');
    const label = await this.dockerRead.readContainerLabel(container, 'com.docker.compose.project');
    if (!label?.found || label.value !== composeProjectForApp(appUrn)) {
      throw new McpStdioLaunchRefused(appUrn, `container ${JSON.stringify(container)} is not one of this app's containers`);
    }
  }
}
