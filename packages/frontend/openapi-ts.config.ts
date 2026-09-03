import { defaultPlugins, defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../backend/src/swagger.json',
  output: {
    path: './src/api-client',
  },
  plugins: [...defaultPlugins, '@tanstack/react-query', '@hey-api/client-fetch'],
});
