import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';

const hubRoot = path.resolve(__dirname, '../..');

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, hubRoot, '');
  /** Same variable as backend/runtime; injected into the client bundle for portal API calls. */
  const ciCloudUrl = (process.env.CI_CLOUD_URL ?? fileEnv.CI_CLOUD_URL ?? '').trim();

  const alias: Record<string, string> = {
    '@': path.resolve(__dirname, './src'),
  };
  const isVitest = process.env.VITEST === 'true';
  const plugins: PluginOption[] = [!isVitest && reactRouter(), tsconfigPaths(), tailwindcss()];

  const { NODE_ENV } = process.env;
  if (NODE_ENV === 'production') {
    // @ts-expect-error
    alias['react-dom/server'] = 'react-dom/server.node';
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
    // @ts-expect-error - Vitest config
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/tests/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
