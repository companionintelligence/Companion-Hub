if (process.env.TIPI_APP_DIR && process.env.TIPI_APP_DIR.includes('Users')) {
    console.error('CRITICAL WARNING: Host path detected in container Env!', process.env.TIPI_APP_DIR);
} else {
    console.log('CONSTANTS LOADED. TIPI_APP_DIR:', process.env.TIPI_APP_DIR);
}

export const APP_DIR = process.env.TIPI_APP_DIR || '/app';
export const DATA_DIR = process.env.TIPI_DATA_DIR || '/data';
export const APP_DATA_DIR = process.env.TIPI_APP_DATA_DIR || '/app-data';

export const SESSION_COOKIE_NAME = 'runtipi-sid';
export const SESSION_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24;

export const ARCHITECTURES = ['arm64', 'amd64'] as const;
export type Architecture = (typeof ARCHITECTURES)[number];
