import { DEFAULT_HUB_CONTAINER_NAME, hubContainerName } from '../constants';

/** A Docker container name: something Traefik can dial, and nothing that could break the YAML line it lands on. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A line of the dynamic config that dials the Hub: the host in its URL, then the rest, ending with the tag. */
const TAGGED_HUB_ADDRESS = /^(.*?\bhttps?:\/\/)[^\s:/"']+(:\d+.*#\s*hub container\b.*)$/gm;

/**
 * Point each line of Traefik's dynamic config tagged `# hub container` at the Hub's container.
 *
 * The asset ships the default name, `ci-hub`, for the reason traefik.yml ships real edge-hop
 * addresses (see `fillEdgeHopAddresses`): the desktop app and the CLI write the file before the Hub
 * ever runs, and Traefik reads it as a Go template. The template placeholder this replaced made
 * Traefik drop the whole file until the Hub had booted and filled it in (Companion-Hub#1832).
 *
 * ⚠ ON THE DEFAULT NAME THE RESULT IS THE ASSET, BYTE FOR BYTE. The desktop app rewrites the file
 * whenever it differs from the copy it bundles, and has Traefik recreated when it does, so any change
 * made here on a default install starts that back-and-forth on every launch again. Only an install
 * on the legacy name (an image-only update under the pre-rename compose file) gets a rewrite. A name
 * that is not a container name leaves the default in place rather than write a line Traefik rejects.
 */
export function fillHubContainerName(content: string, name: string = hubContainerName()): string {
  if (name === DEFAULT_HUB_CONTAINER_NAME || !CONTAINER_NAME.test(name)) {
    return content;
  }

  return content.replace(TAGGED_HUB_ADDRESS, (_line, before: string, after: string) => `${before}${name}${after}`);
}
