import { defaultPlugins, defineConfig } from '@hey-api/openapi-ts';

// `pnpm run gen:api-client` runs this from the repo root on purpose. The generator reads
// `ts.SyntaxKind` from TypeScript's JS API as soon as it loads, and the frontend's TypeScript 7
// exports only `version`, so the generator has to resolve the root's TypeScript 5 instead.
// The generator is pinned to the version that wrote the committed client, so a regeneration
// only carries what changed in swagger.json.
export default defineConfig({
  input: './packages/backend/src/swagger.json',
  output: {
    path: './packages/frontend/src/api-client',
  },
  plugins: [...defaultPlugins, '@tanstack/react-query', '@hey-api/client-fetch'],
});
