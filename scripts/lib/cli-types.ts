export const allowedEnvs = ['local', 'dev', 'staging', 'prod'] as const;

export type HubEnv = (typeof allowedEnvs)[number];

export const BASE_COMMAND = 'cihub';

export const LOCAL_DEV_BACKEND_PORT = '5004';
export const LOCAL_DEV_FRONTEND_PORT = '5005';
export const CI_CLOUD_DEFAULT = 'https://hub.companionintelligence.com';

/** How `cihub up` runs the stack: source dev processes, attached compose, or detached compose. */
export type StartMode = 'local-dev' | 'attached' | 'detached';

export type RegisterHubOptions = {
  fresh?: boolean;
  code?: string;
  /**
   * `--move`: yes, move this Hub from the organization that holds it now into the one the code
   * belongs to, when the Portal asks (`DEVICE_MOVE_CONFIRMATION_REQUIRED`). Without it, a terminal
   * asks and a script is told to run again with it.
   */
  move?: boolean;
};
