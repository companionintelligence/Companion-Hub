import './instrument';

import { type INestApplication, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { DEFAULT_BODY_LIMIT, INFERENCE_BODY_LIMIT, LARGE_BODY_PATHS, payloadTooLargeHandler } from './common/helpers/body-limits';
import { raiseConnectAttemptTimeout } from './common/helpers/connect-attempt-timeout';
import { resolveAllowedCorsOrigin } from './common/helpers/cors-origin';
import { generateSystemEnvFile } from './common/helpers/env-helpers';
import { buildSwaggerDocument, writeSwaggerJsonFile } from './swagger-setup';
import { resolvePortalRootBounce } from './modules/auth/portal-sso';
import { ProxyTrustService } from './modules/network/proxy-trust.service';
import { configureTrustProxy } from './modules/network/trust-proxy';

// Before the app, and every HTTP client in it, is created: Node's 250 ms per address fails a
// connection that is only slow. See CONNECT_ATTEMPT_TIMEOUT_MS.
raiseConnectAttemptTimeout();

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
  try {
    SwaggerModule.setup('api/docs', app, document);
  } catch (error) {
    // The production image leaves swagger-ui-dist out of its bundle (packages/backend/build.ts
    // says why), so running that image with NODE_ENV set to anything but production lands here
    // with "Cannot find module 'swagger-ui-dist/absolute-path.js'". API docs are a development aid;
    // losing the UI must not stop the Hub from booting. setup() registers /api/docs-json before it
    // looks for the UI's files, so the JSON document still serves.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not serve the Swagger UI at /api/docs — skipping (non-fatal): ${message}`);
  }

  try {
    await writeSwaggerJsonFile(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not write swagger.json — skipping (non-fatal): ${message}`);
  }
}

async function bootstrap() {
  await generateSystemEnvFile();

  const app = await NestFactory.create(AppModule, {
    abortOnError: true,
    logger: process.env.NEST_VERBOSE === '1' ? ['log', 'error', 'warn', 'fatal'] : ['error', 'warn', 'fatal'],
    // Body parsing is registered below with per-path limits — see common/helpers/body-limits.ts.
    bodyParser: false,
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

  // Inference and MCP bodies (a whole conversation, every tool schema, base64 images) get the large
  // limit; everything else keeps Nest's default. Registered before Nest binds routes, so the
  // scoped parser runs first and the default one skips a body that is already parsed.
  for (const prefix of LARGE_BODY_PATHS) {
    app.use(prefix, json({ limit: INFERENCE_BODY_LIMIT }));
  }
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));
  app.use(payloadTooLargeHandler);

  // Portal / a proxy can drop `/api/auth/portal/callback` and land on `/` with
  // `?code=&state=` or `?desktop=1`. Bounce those onto the real SSO routes.
  app
    .getHttpAdapter()
    .getInstance()
    .get('/', (req: { query: Record<string, unknown> }, res: { redirect: (url: string) => void }, next: () => void) => {
      const bounce = resolvePortalRootBounce(req.query);
      if (bounce) {
        res.redirect(bounce);
        return;
      }
      next();
    });

  // Express `trust proxy`, which decides `req.ip` for every guard and audit log: the edge hops and
  // Traefik as ProxyTrustService resolves them, or HUB_TRUST_PROXY when an operator sets it. See
  // `resolveTrustProxySetting` for what each allows and why nothing else is trusted.
  configureTrustProxy(app.getHttpAdapter().getInstance(), process.env, app.get(ProxyTrustService, { strict: false }));

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
  // A hub that fails to boot used to exit with only a console.error — nothing
  // reached Sentry, so production appliances that never came up were invisible.
  Sentry.captureException(err);
  void Sentry.close(2000).then(
    () => process.exit(1),
    () => process.exit(1),
  );
});
