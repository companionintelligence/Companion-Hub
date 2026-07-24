import './instrument';

import { type INestApplication, Logger } from '@nestjs/common';
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
    logger: process.env.NEST_VERBOSE === '1' ? ['log', 'error', 'warn', 'fatal'] : ['error', 'warn', 'fatal'],
  });

  const appService = app.get(AppService);
  await appService.bootstrap();

  app.setGlobalPrefix('/api');
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, origin?: string | boolean) => void) => {
      const allowed = resolveAllowedCorsOrigin(origin);
      callback(null, allowed);
    },
    credentials: true,
  });
  app.use(cookieParser());

  // Express `trust proxy`. Behind Traefik / the Cloudflare tunnel, `req.ip` is
  // the proxy's (private) address unless Express is told which hops to trust — so
  // the InternalNetworkGuard IP allowlist is otherwise a no-op for tunnel
  // traffic. Left UNSET by default (current behavior; the managed-app-key guard
  // is the real authorization for the internal routes). An operator who has
  // verified their X-Forwarded-For provenance can set HUB_TRUST_PROXY — a hop
  // count (e.g. "1") or a trusted subnet/IP list (e.g. "172.16.0.0/12") — to make
  // `req.ip` resolve to the real client, turning the IP allowlist into meaningful
  // defense-in-depth. A too-broad value would let a spoofed X-Forwarded-For
  // appear internal, hence opt-in.
  //
  // NOTE: `trust proxy` is a PROCESS-WIDE Express setting — enabling it also
  // changes `req.ip`/`req.protocol` for audit logging, registration, and SSO
  // (generally making them more accurate). An invalid value (e.g. "true") makes
  // Express throw here at startup — fail-closed, but be deliberate about the value.
  const trustProxy = process.env.HUB_TRUST_PROXY?.trim();
  if (trustProxy) {
    const value = /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    app.getHttpAdapter().getInstance().set('trust proxy', value);
  }

  await setupSwagger(app);

  const port = process.env.API_PORT || 3000;
  await app.listen(port, '0.0.0.0');

  const httpServer = app.getHttpServer();
  // Drop slow clients so health probes and UI polling cannot accumulate CLOSE_WAIT sockets.
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 35_000;
  httpServer.keepAliveTimeout = 5_000;
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
