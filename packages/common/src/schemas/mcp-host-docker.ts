/**
 * The `docker run` a `host_docker` MCP listing may make the Hub run: the flags real listings use, a
 * plain env name or port for each, then an image. Enforced on every spawn by the backend's
 * McpStdioLaunchPolicy; here, in common, so the marketplace's copy can be compared with it
 * (schemas/__tests__/marketplace-rules-parity.ts).
 */

/** Flags `docker run` may carry in a listing: name → whether it takes a value. */
const HOST_DOCKER_RUN_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ['-i', false],
  ['--interactive', false],
  ['--rm', false],
  ['--init', false],
  ['-e', true],
  ['--env', true],
  ['-p', true],
  ['--publish', true],
]);

/** `-e NAME` or `-e NAME=value`: a plain variable name, nothing the CLI would read as a file. */
const ENV_FLAG_VALUE = /^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/s;

/** `-p 8080:8080` or `-p 8080` (optionally `/tcp|udp`); no host address, no ranges. */
const PUBLISH_FLAG_VALUE = /^(\d{1,5}:)?\d{1,5}(\/(tcp|udp))?$/;

/** An image reference: registry/name[:tag][@digest]. Never a flag. */
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

/** Why a `host_docker` argv is refused, or null when it is a plain `docker run` within the allowlist. */
export function hostDockerArgvRefusal(command: readonly string[]): string | null {
  if (command[0] !== 'docker' || command[1] !== 'run') {
    return 'a host_docker command must be `docker run …`';
  }
  let i = 2;
  while (i < command.length) {
    const arg = command[i] as string;
    if (!arg.startsWith('-')) break;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const takesValue = HOST_DOCKER_RUN_FLAGS.get(name);
    if (takesValue === undefined) {
      return `docker run flag ${JSON.stringify(name)} is not allowed`;
    }
    if (takesValue) {
      let value: string | undefined;
      if (name === arg) {
        value = command[i + 1];
        i += 1;
      } else {
        value = arg.slice(eq + 1);
      }
      if (value === undefined) return `docker run flag ${name} needs a value`;
      const valid = name === '-e' || name === '--env' ? ENV_FLAG_VALUE.test(value) : PUBLISH_FLAG_VALUE.test(value);
      if (!valid) return `docker run ${name} value ${JSON.stringify(value)} is not allowed`;
    } else if (name !== arg) {
      return `docker run flag ${name} takes no value`;
    }
    i += 1;
  }
  const image = command[i];
  if (!image || !IMAGE_REFERENCE.test(image)) {
    return 'docker run needs an image reference after its flags';
  }
  return null;
}
