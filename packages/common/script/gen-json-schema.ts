import z from 'zod';
import { dynamicComposeUnion, dynamicComposeSchema } from '../src/schemas/dynamic-compose.js';
import fs from 'node:fs/promises';
import { appInfoObjectSchema } from '../src/schemas/app-info.js';
import { dynamicComposeSchemaV1 } from '../src/schemas/utils/converters/v1.js';

const dynamicCompose = z.toJSONSchema(dynamicComposeUnion, { unrepresentable: 'any' });
const appInfo = z.toJSONSchema(appInfoObjectSchema.omit({ urn: true }), { unrepresentable: 'any', io: 'input' });

const outDir = './json-schemas';

const v1 = z.toJSONSchema(dynamicComposeSchemaV1, { unrepresentable: 'any' });
const v2 = z.toJSONSchema(dynamicComposeSchema, { unrepresentable: 'any' });

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(`${outDir}/v1`, { recursive: true });
await fs.mkdir(`${outDir}/v2`, { recursive: true });

await fs.writeFile(`${outDir}/dynamic-compose.json`, JSON.stringify(dynamicCompose, null, 2));
await fs.writeFile(`${outDir}/app-info.json`, JSON.stringify(appInfo, null, 2));

await fs.writeFile(`${outDir}/v1/dynamic-compose.json`, JSON.stringify(v1, null, 2));
await fs.writeFile(`${outDir}/v1/app-info.json`, JSON.stringify(appInfo, null, 2));

await fs.writeFile(`${outDir}/v2/dynamic-compose.json`, JSON.stringify(v2, null, 2));
await fs.writeFile(`${outDir}/v2/app-info.json`, JSON.stringify(appInfo, null, 2));
