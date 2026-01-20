import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const alias = {
  '@': path.resolve(__dirname, './src'),
};
const _isTest = process.env.NODE_ENV === 'test';
const isVitest = process.env.VITEST === 'true';
const plugins: PluginOption[] = [!isVitest && reactRouter(), tsconfigPaths()];

const { NODE_ENV } = process.env;
if (NODE_ENV === 'production') {
  // @ts-expect-error
  alias['react-dom/server'] = 'react-dom/server.node';
  plugins.push(
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: process.env.TIPI_VERSION,
      },
      org: 'runtipi',
      project: 'runtipi-frontend',
    }) as PluginOption,
  );
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins,
  resolve: {
    alias,
  },
  server: {
    open: true,
    host: true,
    port: 9091,
    hmr: {
      timeout: 60000, // 60 seconds - give Vite more time for HMR
    },
    watch: {
      // Ignore directories that shouldn't trigger reloads
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
            // Log connection errors as warnings instead of crashing
            console.warn('[vite] http proxy error:', err.message);
          });
        },
      },
    },
    allowedHosts: true,
  },
  optimizeDeps: {
    // Force re-optimization when dependencies change
    // Set to true to force re-optimization, or false to use cache
    force: false,
    // Include these dependencies in optimization
    include: ['i18next', 'react-i18next', 'i18next-http-backend', 'i18next-browser-languagedetector', '@sentry/react', 'js-cookie'],
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
});
