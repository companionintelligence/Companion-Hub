import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const alias = {
  '@': path.resolve(__dirname, './src'),
};
const plugins: PluginOption[] = [reactRouter(), tsconfigPaths()];

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
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, res) => {
            // Log connection errors as warnings instead of crashing
            console.warn('[vite] http proxy error:', err.message);
          });
        },
      },
    },
    allowedHosts: true,
  },
  optimizeDeps: {
    force: false, // Disable pre-bundling in dev mode, allow on-demand optimization
  },
  build: {
    sourcemap: true,
  },
});
