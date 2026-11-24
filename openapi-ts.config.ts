import { defaultPlugins, defineConfig } from '@hey-api/openapi-ts';

// `pnpm run gen:api-client` runs this from the repo root on purpose. The generator reads
// `ts.SyntaxKind` from TypeScript's JS API as soon as it loads. The frontend's TypeScript 7
// exports only `version`, so the generator has to resolve the root's TypeScript 5 instead.
// The line that keeps it there is `"typescript": "^5"` under `peerDependencies` in the root
// package.json. Delete it and pnpm links the generator to TypeScript 7, which fails every run.
// The generator is pinned to the version that wrote the committed client, so a regeneration
// only carries what changed in swagger.json. `pnpm run check:openapi` fails when the committed
// client isn't what the generator writes.
export default defineConfig({
  input: './packages/backend/src/swagger.json',
  output: {
    path: './packages/frontend/src/api-client',
  },
  plugins: [...defaultPlugins, '@tanstack/react-query', '@hey-api/client-fetch'],
});
