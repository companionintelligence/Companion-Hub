import fs from 'node:fs';
import path from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { APP_DIR } from './common/constants';

export function buildSwaggerDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('CI Hub API')
    .setDescription('API specs for CI Hub')
    .setVersion('1.0')
    .setOpenAPIVersion('3.1.0')
    .build();

  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  });
}

export async function writeSwaggerJsonFile(document: object) {
  const swaggerPath = path.join(APP_DIR, 'packages', 'backend', 'src', 'swagger.json');
  await fs.promises.mkdir(path.dirname(swaggerPath), { recursive: true });
  await fs.promises.writeFile(swaggerPath, `${JSON.stringify(document, null, 2)}\n`);
}
