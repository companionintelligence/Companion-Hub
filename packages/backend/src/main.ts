import './instrument';

import fs from 'node:fs';
import path from 'node:path';
import { type INestApplication, type LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { APP_DIR } from './common/constants';
import { generateSystemEnvFile } from './common/helpers/env-helpers';

async function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('CI Hub API')
    .setDescription('API specs for CI Hub')
    .setVersion('1.0')
    .setOpenAPIVersion('3.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_: string, methodKey: string) => methodKey,
  });
  SwaggerModule.setup('api/docs', app, document);

  const { NODE_ENV } = process.env;
  // write the swagger.json file to the assets folder
  if (NODE_ENV !== 'production') {
    try {
      const swaggerPath = path.join(APP_DIR, 'packages', 'backend', 'src', 'swagger.json');
      await fs.promises.mkdir(path.dirname(swaggerPath), { recursive: true });
      await fs.promises.writeFile(swaggerPath, JSON.stringify(document, null, 2));
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
    logger: [process.env.LOG_LEVEL as LogLevel, 'error', 'warn', 'fatal'],
  });

  const appService = app.get(AppService);
  await appService.bootstrap();

  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors();
  app.use(cookieParser());

  await setupSwagger(app);

  const port = process.env.API_PORT || 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
