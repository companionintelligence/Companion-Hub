import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { createLogger, defineConfig, loadEnv, type Logger, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

const hubRoot = path.resolve(__dirname, '../..');

const ORIGINAL_LOCATION_NOISE = "Can't resolve original location of error";

/** True when Vite/Rollup emitted the known sourcemap noise warning (plain string or object with `message`). */
function isOriginalLocationNoise(msg: unknown): boolean {
  if (typeof msg === 'string') return msg.includes(ORIGINAL_LOCATION_NOISE);
  if (msg && typeof msg === 'object') {
    const m = (msg as { message?: unknown }).message;
    if (typeof m === 'string' && m.includes(ORIGINAL_LOCATION_NOISE)) return true;
  }
  try {
    return JSON.stringify(msg).includes(ORIGINAL_LOCATION_NOISE);
  } catch {
    return String(msg).includes(ORIGINAL_LOCATION_NOISE);
  }
}

/** Rollup sometimes prints this when a plugin reports a warning with a bad sourcemap; it is noise-only. */
function createFilteredViteLogger(): Logger {
  const logger = createLogger();
  const origWarn = logger.warn.bind(logger);
  logger.warn = (msg, options) => {
    if (isOriginalLocationNoise(msg)) return;
    origWarn(msg, options);
  };
  return logger;
}

/** CI-Hub uses `.env.dev` / `.env.local` at repo root; Vite's loadEnv only reads `.env.[mode]` etc. */
function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  try {
    if (!statSync(filePath).isFile()) return {};
  } catch {
    return {};
  }

  const out: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadCiHubRootEnvFiles(root: string): Record<string, string> {
  const names = ['.env', '.env.prod', '.env.staging', '.env.dev', '.env.local'];
  const merged: Record<string, string> = {};
  for (const n of names) {
    Object.assign(merged, parseDotEnvFile(path.join(root, n)));
  }
  return merged;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, hubRoot, '');
  const hubFileEnv = loadCiHubRootEnvFiles(hubRoot);
  /** Same variable as backend/runtime; injected into the client bundle for portal API calls. */
  const ciCloudUrl = (process.env.CI_CLOUD_URL ?? fileEnv.CI_CLOUD_URL ?? hubFileEnv.CI_CLOUD_URL ?? '').trim();
  const ciHubVersion = (process.env.CI_HUB_VERSION ?? fileEnv.CI_HUB_VERSION ?? hubFileEnv.CI_HUB_VERSION ?? '').trim();
  const ciHubImage = (process.env.CI_HUB_IMAGE ?? fileEnv.CI_HUB_IMAGE ?? hubFileEnv.CI_HUB_IMAGE ?? '').trim();
  /**
   * Matches the Rust binary's compile-time `CI_HUB_ENVIRONMENT` check.
   * Injected so the frontend can derive correct defaults without relying on
   * `import.meta.env.DEV` (which is always false in any `vite build`).
   */
  const ciHubEnvironment = (process.env.CI_HUB_ENVIRONMENT ?? fileEnv.CI_HUB_ENVIRONMENT ?? hubFileEnv.CI_HUB_ENVIRONMENT ?? '').trim();

  const alias: Record<string, string> = {
    '@': path.resolve(__dirname, './src'),
  };
  const isVitest = process.env.VITEST === 'true';
  const plugins: PluginOption[] = [!isVitest && reactRouter(), tsconfigPaths(), tailwindcss()];

  const { NODE_ENV } = process.env;
  if (NODE_ENV === 'production') {
    alias['react-dom/server'] = 'react-dom/server.node';
  }

  return {
    customLogger: createFilteredViteLogger(),
    plugins,
    define: {
      'import.meta.env.CI_CLOUD_URL': JSON.stringify(ciCloudUrl),
      'import.meta.env.CI_HUB_VERSION': JSON.stringify(ciHubVersion),
      'import.meta.env.CI_HUB_IMAGE': JSON.stringify(ciHubImage),
      'import.meta.env.CI_HUB_ENVIRONMENT': JSON.stringify(ciHubEnvironment),
    },
    resolve: {
      alias,
      dedupe: ['@tanstack/react-query'],
      preserveSymlinks: false,
    },
    server: {
      open: true,
      host: true,
      port: Number(process.env.FRONTEND_PORT || 5005),
      hmr: {
        timeout: 60000,
      },
      watch: {
        ignored: [
          '**/.internal/**',
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/.turbo/**',
          '**/app-data/**',
          '**/data/**',
          '**/repos/**',
          '**/apps/**',
          '**/traefik/**',
          '**/backups/**',
          '**/state/**',
          '**/cache/**',
          '**/media/**',
          '**/user-config/**',
        ],
      },
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.API_PORT || 5004}`,
          changeOrigin: false,
          configure: (proxy, _options) => {
            proxy.on('error', (err, _req, _res) => {
              console.warn('[vite] http proxy error:', err.message);
            });
          },
        },
      },
      allowedHosts: true,
    },
    optimizeDeps: {
      force: false,
      include: ['i18next', 'react-i18next', 'i18next-http-backend', 'i18next-browser-languagedetector', '@tanstack/react-query'],
    },
    preview: {
      port: Number(process.env.FRONTEND_PORT || 5005),
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.API_PORT || 5004}`,
          changeOrigin: false,
        },
      },
    },
    build: {
      // Off by default: production client maps are noisy (Rollup/Tailwind "Can't resolve
      // original location") and expose server code. Set VITE_BUILD_SOURCEMAPS=1 to enable.
      sourcemap: process.env.VITE_BUILD_SOURCEMAPS === '1',
    },
    esbuild: {
      jsxInject: isVitest ? `import React from 'react'` : undefined,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/tests/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
