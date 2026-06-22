import os from 'node:os';

export function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED');
}

function isBridgeNetworkError(error: string): boolean {
  return (
    error.includes('ECONNREFUSED') ||
    error.includes('ETIMEDOUT') ||
    error.includes('EHOSTUNREACH') ||
    error.includes('ENOTFOUND') ||
    error.includes('socket hang up') ||
    error.includes('network unreachable')
  );
}

/**
 * Returns true for network-layer failures that indicate the Hub container
 * could not reach host-side Ollama over the Docker bridge.
 *
 * On Linux with Docker Desktop the host-gateway may resolve to IPv6; Node.js can
 * return ETIMEDOUT or EHOSTUNREACH rather than ECONNREFUSED. When the configured
 * URL targets host.docker.internal, any of those network errors count as a bridge failure.
 */
export function isBridgeConnectionRefused(error?: string, configuredUrl?: string): boolean {
  if (!error) return false;

  const isNetworkError = isBridgeNetworkError(error);

  if (configuredUrl?.includes('host.docker.internal')) {
    return isNetworkError;
  }

  if (!isNetworkError) return false;

  return error.includes('172.17.') || error.includes('172.18.') || error.includes('host.docker.internal');
}

export function resolveHostPlatform(): NodeJS.Platform {
  const override = process.env.CI_HUB_HOST_PLATFORM;
  if (override === 'darwin' || override === 'linux' || override === 'win32') {
    return override;
  }
  return os.platform();
}

function getOllamaRunningTip(hostPlatform?: string): string {
  switch (hostPlatform) {
    case 'darwin':
      return 'Ensure the Ollama app is running (check the menu bar), then re-check.';
    case 'win32':
      return 'Ensure Ollama is running (check the system tray or Start menu), then re-check.';
    case 'linux':
      return 'Ensure Ollama is running on the host (on systemd Linux: systemctl status ollama), then re-check.';
    default:
      return 'Ensure Ollama is running on the host, then re-check.';
  }
}

/** User-facing guidance when host Ollama is likely installed but unreachable from the Hub container. */
export function buildBridgeConnectionHint(hostPlatform?: string): string {
  const runningTip = getOllamaRunningTip(hostPlatform);
  return (
    `Ollama may already be installed on this machine, but the Hub container could not connect to it. ${runningTip} ` +
    'If the Hub runs in Docker, configure Ollama to listen on all interfaces (OLLAMA_HOST=0.0.0.0:11434) so containers can reach it.'
  );
}
