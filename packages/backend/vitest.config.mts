import path from 'node:path';
import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths() as unknown] as Plugin[],
  test: {
    setupFiles: ['./src/tests/vite.setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['**/integration/**', '**/.internal/**'],
    coverage: { reporter: ['lcov', 'text-summary'] },
    reporters: ['default'],
    env: {
      NODE_OPTIONS: '--experimental-sqlite',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Vitest does not resolve workspace package.json `exports` the same as Bun/Node; map to source.
      '@ci-hub/common/schemas': path.resolve(__dirname, '../common/src/schemas/index.ts'),
      '@ci-hub/common/types': path.resolve(__dirname, '../common/src/types/index.ts'),
    },
  },
});
