/**
 * Preload for `gen:swagger`: loads monorepo root `.env*` before Nest imports
 * (so `constants.ts` sees CI_HUB_APP_DIR, ROOT_FOLDER_HOST, CI_CLOUD_URL, etc.)
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env.dev'), override: true });
dotenv.config({ path: path.join(repoRoot, '.env.local'), override: true });

if (!process.env.CI_HUB_APP_DIR) {
  process.env.CI_HUB_APP_DIR = repoRoot;
}

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.CI_HUB_VERSION) {
  const backendPkgPath = path.join(repoRoot, 'packages', 'backend', 'package.json');
  const { version } = JSON.parse(fs.readFileSync(backendPkgPath, 'utf8'));
  process.env.CI_HUB_VERSION = version;
}

process.env.CI_HUB_OPENAPI_GENERATE = '1';

// CI and fresh clones often have no `.env*` — provide minimal writable state + config.
const openapiDataDir = process.env.CI_HUB_DATA_DIR || path.join(os.tmpdir(), 'ci-hub-openapi-gen');
process.env.CI_HUB_DATA_DIR = openapiDataDir;
if (!process.env.ROOT_FOLDER_HOST) {
  process.env.ROOT_FOLDER_HOST = openapiDataDir;
}
if (!process.env.CI_CLOUD_URL) {
  process.env.CI_CLOUD_URL = 'https://hub.companionintelligence.com';
}

// generateSystemEnvFile resolves most vars but never mints POSTGRES_PASSWORD (deploy-time secret).
// Seed openapi-only defaults so ConfigurationService can boot for swagger generation.
const openapiDefaults = {
  POSTGRES_PASSWORD: 'openapi-gen',
};
for (const [key, value] of Object.entries(openapiDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

fs.mkdirSync(path.join(openapiDataDir, 'state'), { recursive: true });
const openapiEnvPath = path.join(openapiDataDir, '.env');
if (!fs.existsSync(openapiEnvPath)) {
  fs.writeFileSync(
    openapiEnvPath,
    `${[`ROOT_FOLDER_HOST=${openapiDataDir}`, `CI_CLOUD_URL=${process.env.CI_CLOUD_URL}`, `POSTGRES_PASSWORD=${process.env.POSTGRES_PASSWORD}`].join('\n')}\n`,
  );
}
