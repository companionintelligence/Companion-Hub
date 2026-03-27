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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ci-hub/common/schemas': path.resolve(__dirname, '../common/src/schemas/index.ts'),
      '@ci-hub/common/types': path.resolve(__dirname, '../common/src/types/index.ts'),
    },
  },
});
