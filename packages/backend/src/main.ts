import './instrument';

import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { generateSystemEnvFile } from './common/helpers/env-helpers';
import { buildSwaggerDocument, writeSwaggerJsonFile } from './swagger-setup';

// Process-level safety nets for failures that escape local try/catch handlers.
// - unhandledRejection: log and keep running — detached async work (e.g. a DB
//   write in a fire-and-forget lifecycle callback) should degrade gracefully.
// - uncaughtException: log and exit — Node may be in an undefined state after a
//   synchronous throw; let the desktop wrapper/supervisor restart the backend.
const processLogger = new Logger('Process');

process.on('unhandledRejection', (reason: unknown) => {
  processLogger.error(
    `Unhandled promise rejection (process kept alive): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  Sentry.captureException(reason);
});

process.on('uncaughtException', (error: Error) => {
  processLogger.error(`Uncaught exception — exiting for clean restart: ${error.stack ?? error.message}`);
  Sentry.captureException(error);
  process.exit(1);
});

async function setupSwagger(app: INestApplication) {
  const document = buildSwaggerDocument(app);
  SwaggerModule.setup('api/docs', app, document);

  const { NODE_ENV } = process.env;
  if (NODE_ENV !== 'production') {
    try {
      await writeSwaggerJsonFile(document);
    } catch (error) {
      // Non-fatal — swagger.json is just for API docs during development
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not write swagger.json — skipping (non-fatal): ${message}`);
    }
  }
}

async function bootstrap() {
  await generateSystemEnvFile();

  const app = await NestFactory.create(AppModule, {
    abortOnError: true,
    logger: ['log', 'error', 'warn', 'fatal'],
  });

  const appService = app.get(AppService);
  await appService.bootstrap();

  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, origin?: string | boolean) => void) => {
      // Allow Tauri desktop origins and same-origin (no origin header) requests
      if (!origin || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost' || origin.startsWith('http://localhost')) {
        callback(null, origin || true);
      } else {
        // Allow all other origins without credentials
        callback(null, origin);
      }
    },
    credentials: true,
  });
  app.use(cookieParser());

  await setupSwagger(app);

  const port = process.env.API_PORT || 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
