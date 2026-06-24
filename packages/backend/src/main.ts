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
  // Flush buffered events before exiting; process.exit otherwise truncates the
  // async Sentry transport and the crash report is lost. close() resolves even
  // when Sentry is disabled (no DSN), so the supervisor still restarts promptly.
  void Sentry.close(2000).then(
    () => process.exit(1),
    () => process.exit(1),
  );
});

async function setupSwagger(app: INestApplication) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const document = buildSwaggerDocument(app);
  SwaggerModule.setup('api/docs', app, document);

  try {
    await writeSwaggerJsonFile(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not write swagger.json — skipping (non-fatal): ${message}`);
  }
}

function resolveAllowedCorsOrigin(origin: string | undefined): string | boolean {
  if (!origin) {
    return true;
  }
  // Tauri webview origins. Windows (WebView2) serves the app from
  // http(s)://tauri.localhost, while Linux (webkit2gtk) and macOS (WKWebView)
  // serve it from the custom-protocol origin tauri://localhost.
  if (origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost' || origin === 'tauri://localhost') {
    return origin;
  }
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return origin;
  }
  const domain = process.env.DOMAIN?.trim();
  if (domain && (origin === `https://${domain}` || origin === `http://${domain}`)) {
    return origin;
  }
  const localDomain = process.env.LOCAL_DOMAIN?.trim();
  if (localDomain && (origin === `https://${localDomain}` || origin === `http://${localDomain}`)) {
    return origin;
  }
  return false;
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
      const allowed = resolveAllowedCorsOrigin(origin);
      callback(null, allowed);
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
