import z from 'zod';
import { dynamicComposeUnion } from '../src/schemas/dynamic-compose.js';
import fs from 'node:fs/promises';
import { appInfoSchema } from '../src/schemas/app-info.js';
import { dynamicComposeSchemaArk } from '../src/schemas/dynamic-compose-ark.js';
import { dynamicComposeSchemaV1 } from '../src/schemas/utils/converters/v1.js';

async function generateJsonSchema() {
const dynamicCompose = z.toJSONSchema(dynamicComposeUnion, { unrepresentable: 'any' });
const appInfo = z.toJSONSchema(appInfoSchema.omit({ urn: true }), { unrepresentable: 'any', io: 'input' });

const outDir = './json-schemas';

const v1 = z.toJSONSchema(dynamicComposeSchemaV1, { unrepresentable: 'any' });
const v2 = dynamicComposeSchemaArk.toJsonSchema({});

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(`${outDir}/v1`, { recursive: true });
await fs.mkdir(`${outDir}/v2`, { recursive: true });

await fs.writeFile(`${outDir}/dynamic-compose.json`, JSON.stringify(dynamicCompose, null, 2));
await fs.writeFile(`${outDir}/app-info.json`, JSON.stringify(appInfo, null, 2));

await fs.writeFile(`${outDir}/v1/dynamic-compose.json`, JSON.stringify(v1, null, 2));
await fs.writeFile(`${outDir}/v1/app-info.json`, JSON.stringify(appInfo, null, 2));

await fs.writeFile(`${outDir}/v2/dynamic-compose.json`, JSON.stringify(v2, null, 2));
await fs.writeFile(`${outDir}/v2/app-info.json`, JSON.stringify(appInfo, null, 2));
}

generateJsonSchema().catch((err) => {
  console.error(err);
  process.exit(1);
});
