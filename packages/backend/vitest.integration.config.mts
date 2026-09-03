import path from 'node:path';
import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths() as unknown] as Plugin[],
  test: {
    testTimeout: 30000,
    setupFiles: ['./src/tests/vite.setup.ts'],
    include: ['src/**/integration/**/*.test.ts'],
    reporters: ['default'],
    env: {
      // Same pin as vitest.config.mts: the integration snapshots record the memfs tree keyed by
      // container paths (`/data/repos/...`). Without this, resolveDataDir() falls through to the
      // host branch (ROOT_FOLDER_HOST, else ~/.ci-hub) and every path in the snapshot shifts.
      CI_HUB_DATA_DIR: '/data',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ci-hub/common/schemas': path.resolve(__dirname, '../common/src/schemas/index.ts'),
      '@ci-hub/common/types': path.resolve(__dirname, '../common/src/types/index.ts'),
    },
  },
});
