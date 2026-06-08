/** Short, plain-language hints for Tauri startup service rows (keyed by Docker container name). */
export const STARTUP_SERVICE_HINTS: Record<string, string> = {
  'ci-hub-db': 'Stores your Hub settings and app data.',
  'ci-os-hub-queue': 'Handles background tasks between Hub services.',
  'ci-os-hub': 'The main Hub app your browser talks to.',
  traefik: 'Routes web traffic to your installed apps.',
  'hub-tailscale': 'Optional private access over your Tailscale network.',
  cloudflared: 'Optional public web address for your Hub.',
  'ci-hub-ollama': 'Optional local AI model server.',
};

export const STARTUP_PROGRESS_HINT = 'How close the core Hub services are to being ready.';
export const STARTUP_IMAGE_PULL_HINT = 'App images downloading on first launch; can take a few minutes.';

export const DOCKER_REQUIRED_HINT = 'Hub runs your apps in Docker. Install and open Docker before the Hub can start.';
export const DOCKER_MAC_ARCH_HINT = 'Pick the version that matches your Mac chip.';
export const DOCKER_DAEMON_HINT = 'Docker is installed but not running yet. Start Docker and wait for it to finish starting.';

export const REGISTRATION_DEVICE_ID_HINT =
  'This identifies the Companion Hub you are registering. You can copy it for reference, but you do not need to paste it into Companion Account.';
export const REGISTRATION_PAIRING_CODE_HINT = 'Six-character code shown in Companion Account after you click Add Device.';
export const REGISTRATION_ACCOUNT_HINT =
  'Sign in to Companion Account, click Add Device, name this Companion Hub, and copy the pairing code shown there.';
export const REGISTRATION_PROVISIONING_HINT = 'Setting up your web address and secure connection. Usually a few minutes.';
export const REGISTRATION_DNS_HINT = 'Web address changes can take a few minutes to work everywhere.';

export const ONBOARDING_REMOTE_VPN_HINT = 'Reach your Hub only from devices on your private Tailscale network.';
export const ONBOARDING_REMOTE_WEB_HINT = 'A public web link to your Hub. Requires device registration.';
export const ONBOARDING_BACKEND_OLLAMA_HINT = 'Runs AI models on your computer. Works on most hardware.';
export const ONBOARDING_BACKEND_VLLM_HINT = 'High-speed AI for powerful NVIDIA GPUs.';
export const ONBOARDING_BACKEND_LEMONADE_HINT = 'AI tuned for laptops with a built-in NPU chip.';
