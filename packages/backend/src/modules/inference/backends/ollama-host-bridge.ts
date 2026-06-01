import os from 'node:os';

export function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED');
}

/** True when the Hub tried a host-gateway URL but could not reach host Ollama. */
export function isBridgeConnectionRefused(error?: string, configuredUrl?: string): boolean {
  if (!error || !isConnectionRefused(error)) return false;

  if (configuredUrl?.includes('host.docker.internal')) return true;

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
