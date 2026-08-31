import fs from 'node:fs';

/**
 * Shared URL plumbing for the **host-run** inference backends — vLLM (via vLLM-Metal on Apple
 * Silicon) and mlx-dspark. Both are servers the operator installs and starts themselves, so the
 * Hub only ever holds a URL pointing at them, and both need the same two fixups: tolerate the
 * `/v1` suffix an operator naturally pastes out of an OpenAI client config, and translate the
 * operator's `localhost` into something that resolves from inside the Hub's own container.
 *
 * Kept in one place deliberately: an earlier draft of the mlx-dspark backend copied
 * `detectHubContainer` verbatim into a second file, which is exactly how the two copies drift.
 */

/** Accept `http://host:8080`, `http://host:8080/` or `http://host:8080/v1` and return the bare origin. */
export function normalizeHostBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Hub container probe — `/.dockerenv` plus Podman's containerenv. Not the `/data` heuristic. */
export function detectHubContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

/**
 * Operator `localhost` / `127.0.0.1` means the host where the backend runs. From inside the Hub
 * container that hostname is the container itself — rewrite only then. A remote host is left
 * alone, so a Mac serving a Hub on another box keeps working.
 */
export function resolveHostBackendProbeUrl(url: string, inContainer: boolean = detectHubContainer()): string {
  const normalized = normalizeHostBackendUrl(url);
  if (!inContainer) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
      parsed.hostname = 'host.docker.internal';
      return normalizeHostBackendUrl(parsed.toString());
    }
  } catch {
    // Keep normalized input; healthCheck will surface a bad URL.
  }
  return normalized;
}
