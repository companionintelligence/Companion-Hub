import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { generateSystemEnvFile } from './common/helpers/env-helpers';
import { buildSwaggerDocument, writeSwaggerJsonFile } from './swagger-setup';

// Process-level safety nets. A detached async failure (e.g. a bad DB write in a
// fire-and-forget app lifecycle callback) must NOT terminate the Hub. Log it
// and keep running so the desktop app degrades gracefully instead of crashing.
const processLogger = new Logger('Process');

process.on('unhandledRejection', (reason: unknown) => {
  processLogger.error(
    `Unhandled promise rejection (process kept alive): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

process.on('uncaughtException', (error: Error) => {
  processLogger.error(`Uncaught exception (process kept alive): ${error.stack ?? error.message}`);
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
