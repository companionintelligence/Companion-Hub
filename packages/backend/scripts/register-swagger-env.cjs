/**
 * Preload for `gen:swagger`: loads monorepo root `.env*` before Nest imports
 * (so `constants.ts` sees CI_HUB_APP_DIR, ROOT_FOLDER_HOST, CI_CLOUD_URL, etc.)
 */
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
