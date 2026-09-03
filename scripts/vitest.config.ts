import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.{test,spec}.ts'],
    exclude: [],
    root: import.meta.dirname,
  },
});
