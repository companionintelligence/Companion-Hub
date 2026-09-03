/**
 * Writes `src/swagger.json` from current Nest controllers (OpenAPI 3.1).
 * Skips `AppService.bootstrap()` so Postgres migrations / Docker are not required.
 *
 * Run via `pnpm run gen:swagger` from `packages/backend` (uses `register-swagger-env.cjs`
 * so `.env` / `.env.dev` load before any Nest module reads `constants.ts`).
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
  await writeSwaggerJsonFile(document);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
