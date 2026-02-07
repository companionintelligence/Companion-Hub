#!/usr/bin/env bun
/**
 * App Catalog Test Generator
 *
 * Generates test specs for all apps in CI-App-Store
 * and distributes them across fleet servers for parallel testing.
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const APP_STORE_PATH = '../CI-App-Store/apps';
const OUTPUT_PATH = './e2e/generated';

interface AppConfig {
  id: string;
  name: string;
  port?: number;
  url_suffix?: string;
  no_gui?: boolean;
  supported_architectures?: string[];
  tipiVersion?: number;
  categories?: string[];
}

interface AppTestSpec {
  id: string;
  storeSlug: string;
  name: string;
  expectedPort: number;
  healthEndpoint: string;
  hasGui: boolean;
  categories: string[];
  priority: 'high' | 'medium' | 'low';
}

// High priority apps - commonly used, should always work
const HIGH_PRIORITY_APPS = [
  'home-assistant',
  'nextcloud',
  'jellyfin',
  'plex',
  'immich',
  'vaultwarden',
  'portainer',
  'nginx',
  'traefik',
  'code-server',
  'ollama',
  'open-webui',
  'homarr',
  'homepage',
  'uptime-kuma',
];

// Apps to skip (known issues or special requirements)
const SKIP_APPS = [
  '_template', // Template, not a real app
];

async function loadAppConfig(appId: string): Promise<AppConfig | null> {
  try {
    const configPath = join(APP_STORE_PATH, appId, 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    return { id: appId, ...config };
  } catch (e) {
    console.warn(`Skipping ${appId}: ${e}`);
    return null;
  }
}

async function generateTestCatalog(): Promise<AppTestSpec[]> {
  const apps = await readdir(APP_STORE_PATH);
  const catalog: AppTestSpec[] = [];

  for (const appId of apps) {
    if (SKIP_APPS.includes(appId)) continue;

    const config = await loadAppConfig(appId);
    if (!config) continue;

    // Skip if doesn't support amd64
    if (config.supported_architectures && !config.supported_architectures.includes('amd64')) {
      console.log(`Skipping ${appId}: no amd64 support`);
      continue;
    }

    const priority = HIGH_PRIORITY_APPS.includes(appId)
      ? 'high'
      : config.categories?.includes('development') || config.categories?.includes('media')
        ? 'medium'
        : 'low';

    catalog.push({
      id: appId,
      storeSlug: 'ci-apps',
      name: config.name,
      expectedPort: config.port || 80,
      healthEndpoint: config.url_suffix || '/',
      hasGui: !config.no_gui,
      categories: config.categories || [],
      priority,
    });
  }

  // Sort by priority (high first)
  catalog.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  return catalog;
}

async function generateTestFile(apps: AppTestSpec[], serverIndex: number): Promise<string> {
  const testCode = `
/**
 * Auto-generated app catalog tests for server batch ${serverIndex}
 * Generated: ${new Date().toISOString()}
 * Apps: ${apps.length}
 */

import { expect, installApp, loginUser, test } from '../fixtures/fixtures';

const APPS = ${JSON.stringify(apps, null, 2)};

test.describe('App Catalog Batch ${serverIndex}', () => {
  test.beforeEach(async ({ page, context }) => {
    await loginUser(page, context);
  });

  for (const app of APPS) {
    test.describe(\`App: \${app.name}\`, () => {
      test(\`install \${app.id}\`, async ({ page }) => {
        await page.goto(\`/app-store/\${app.storeSlug}/\${app.id}\`);
        await page.getByRole('button', { name: 'Install' }).click();
        await expect(page.getByText(/running|installed/i)).toBeVisible({ 
          timeout: 180000 
        });
      });

      if (app.hasGui) {
        test(\`access \${app.id} via subdomain\`, async ({ page, context }) => {
          const subdomain = \`test-\${app.id}\`;
          const url = \`https://\${subdomain}.\${process.env.TEST_DOMAIN || 'test.ci.computer'}\${app.healthEndpoint}\`;
          
          const appPage = await context.newPage();
          const response = await appPage.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
          });
          
          expect(response?.status()).toBeLessThan(500);
          
          await appPage.screenshot({
            path: \`./e2e/screenshots/catalog/\${app.id}.png\`,
            fullPage: true,
          });
          
          await appPage.close();
        });
      }

      test(\`cleanup \${app.id}\`, async ({ page }) => {
        await page.goto(\`/apps/\${app.id}\`);
        await page.getByRole('button', { name: /delete|uninstall/i }).click();
        await page.getByRole('button', { name: /confirm/i }).click();
        await expect(page.getByText(/deleted|removed/i)).toBeVisible({ 
          timeout: 60000 
        });
      });
    });
  }
});
`;

  return testCode;
}

async function main() {
  console.log('Generating app catalog tests...');

  const catalog = await generateTestCatalog();
  console.log(`Found ${catalog.length} testable apps`);

  // Count by priority
  const highCount = catalog.filter((a) => a.priority === 'high').length;
  const medCount = catalog.filter((a) => a.priority === 'medium').length;
  const lowCount = catalog.filter((a) => a.priority === 'low').length;
  console.log(`Priority: ${highCount} high, ${medCount} medium, ${lowCount} low`);

  // Save full catalog
  await writeFile(join(OUTPUT_PATH, 'catalog.json'), JSON.stringify(catalog, null, 2));

  // Split into batches for 7 servers
  const SERVERS = 7;
  const batchSize = Math.ceil(catalog.length / SERVERS);

  for (let i = 0; i < SERVERS; i++) {
    const batch = catalog.slice(i * batchSize, (i + 1) * batchSize);
    const testCode = await generateTestFile(batch, i);
    await writeFile(join(OUTPUT_PATH, `catalog-batch-${i}.spec.ts`), testCode);
    console.log(`Generated batch ${i}: ${batch.length} apps`);
  }

  // Generate summary
  const summary = {
    generated: new Date().toISOString(),
    totalApps: catalog.length,
    batches: SERVERS,
    appsPerBatch: batchSize,
    byPriority: { high: highCount, medium: medCount, low: lowCount },
    byCategory: catalog.reduce(
      (acc, app) => {
        for (const cat of app.categories) {
          acc[cat] = (acc[cat] || 0) + 1;
        }
        return acc;
      },
      {} as Record<string, number>,
    ),
  };

  await writeFile(join(OUTPUT_PATH, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('Done! Generated test files in', OUTPUT_PATH);
}

main().catch(console.error);
