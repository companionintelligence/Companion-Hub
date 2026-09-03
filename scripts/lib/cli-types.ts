export const allowedEnvs = ['local', 'dev', 'staging', 'prod'] as const;

export type HubEnv = (typeof allowedEnvs)[number];

export const BASE_COMMAND = 'cihub';

export const LOCAL_DEV_BACKEND_PORT = '5004';
export const LOCAL_DEV_FRONTEND_PORT = '5005';
export const CI_CLOUD_DEFAULT = 'https://hub.companionintelligence.com';
