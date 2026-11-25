import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // marketplace-rules-parity.test.ts loads CI-Marketplace's copies of these rules from a checkout of
      // that repo, which needs no install of its own: its `zod` resolves to this package's.
      { find: /^zod$/, replacement: fileURLToPath(import.meta.resolve('zod')) },
    ],
  },
});
