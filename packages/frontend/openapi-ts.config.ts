import { defaultPlugins, defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../backend/src/swagger.json',
  output: {
    path: './src/api-client',
    format: 'biome',
  },
  plugins: [...defaultPlugins, '@tanstack/react-query', '@hey-api/client-fetch'],
});
