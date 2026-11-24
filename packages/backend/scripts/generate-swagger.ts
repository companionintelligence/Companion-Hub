/**
 * Writes `src/swagger.json` from current Nest controllers (OpenAPI 3.1).
 * Skips `AppService.bootstrap()` so Postgres migrations / Docker are not required.
 *
 * Run via `pnpm run gen:swagger` from `packages/backend` (uses `register-swagger-env.cjs`
 * so `.env` / `.env.dev` load before any Nest module reads `constants.ts`).
 *
 * `CI_HUB_SWAGGER_OUT` writes the document to that path instead, so `check:openapi` can compare
 * without touching the tracked file. An env var, not an argument: pnpm appends forwarded arguments
 * to the end of the `tsx compile.ts && node ...` script, where only `tsx` would see them.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { buildSwaggerDocument, writeSwaggerJsonFile } from '../src/swagger-setup';
import { generateSystemEnvFile } from '../src/common/helpers/env-helpers';

async function main() {
  process.env.NODE_ENV ??= 'development';

  await generateSystemEnvFile();

  const app = await NestFactory.create(AppModule, {
    abortOnError: true,
    logger: ['log', 'error', 'warn', 'fatal'],
  });

  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe());

  const document = buildSwaggerDocument(app);
  SwaggerModule.setup('api/docs', app, document);
  await writeSwaggerJsonFile(document, process.env.CI_HUB_SWAGGER_OUT || undefined);
  // Do not await app.close(): registration bootstrap leaves cloud/interval handles open
  // and this CLI's only job is the written file.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
