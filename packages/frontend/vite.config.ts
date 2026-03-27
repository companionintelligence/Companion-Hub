import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

const hubRoot = path.resolve(__dirname, '../..');

/** CI-Hub uses `.env.dev` / `.env.local` at repo root; Vite's loadEnv only reads `.env.[mode]` etc. */
function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
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

  const alias: Record<string, string> = {
    '@': path.resolve(__dirname, './src'),
  };
  const isVitest = process.env.VITEST === 'true';
  const plugins: PluginOption[] = [!isVitest && reactRouter(), tsconfigPaths(), tailwindcss()];

  const { NODE_ENV } = process.env;
  if (NODE_ENV === 'production') {
    alias['react-dom/server'] = 'react-dom/server.node';
    // Avoid failing CI / local release builds when no Sentry auth token is configured.
    if (process.env.SENTRY_AUTH_TOKEN) {
      plugins.push(
        sentryVitePlugin({
          authToken: process.env.SENTRY_AUTH_TOKEN,
          release: {
            name: process.env.CI_HUB_VERSION || process.env.TIPI_VERSION,
          },
          org: 'companionintelligence',
          project: 'ci-hub-frontend',
        }) as PluginOption,
      );
    }
  }

  return {
    plugins,
    define: {
      'import.meta.env.CI_CLOUD_URL': JSON.stringify(ciCloudUrl),
    },
    resolve: {
      alias,
      dedupe: ['@tanstack/react-query'],
      preserveSymlinks: false,
    },
    server: {
      open: true,
      host: true,
      port: 9091,
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
          target: `http://localhost:${process.env.API_PORT || 3000}`,
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
      include: [
        'i18next',
        'react-i18next',
        'i18next-http-backend',
        'i18next-browser-languagedetector',
        '@sentry/react',
        'js-cookie',
        '@tanstack/react-query',
      ],
    },
    preview: {
      port: 9091,
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.API_PORT || 3000}`,
          changeOrigin: false,
        },
      },
    },
    build: {
      sourcemap: true,
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
