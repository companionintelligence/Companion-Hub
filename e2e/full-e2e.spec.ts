import { test, expect, request } from '@playwright/test';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { db } from './helpers/db'; // Import db helper
import * as schema from '../packages/backend/src/core/database/drizzle/schema'; // Relative to project root
import * as argon2 from 'argon2'; // Try importing argon2
import { eq } from 'drizzle-orm';

// Configuration
const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';
const CLOUD_APP_DIR = path.resolve(__dirname, '../../CI-Cloud/apps/hono-app'); // Absolute path
const LOCAL_DB_PATH = path.join(CLOUD_APP_DIR, 'local.db');

// Environment Detection
const IS_STAGING = process.env.CI_CLOUD_API_URL?.includes('staging') || false;

// Config - use Env provided or generate random for local
const TEST_ORG_SLUG = process.env.CI_HUB_ORGANIZATION_ID || 'e2e-org-test-' + Date.now();
// API Key will be fetched if staging
let TEST_API_KEY = process.env.CI_HUB_API_KEY || 'test-api-key-e2e-' + Date.now();
const TEST_ORG_ID = process.env.CI_HUB_ORGANIZATION_ID ? process.env.CI_HUB_ORGANIZATION_ID : 'org_' + Date.now(); // Org ID often matches slug in some setups, but here we keep distinct if needed
const TARGET_DEVICE_ID = process.env.DEVICE_ID || 'test-device-id';

// Paths
const ENV_PATH = process.env.ENV_FILE 
  ? path.resolve(__dirname, '..', process.env.ENV_FILE)
  : path.join(__dirname, '../.env');

// Helpers
async function seedHubUser() {
  console.log('Seeding Hub User (test@example.com)...');
  try {
    const hashedPassword = await argon2.hash('password123');

    // Check if user exists
    const existing = await db.select().from(schema.user).where(eq(schema.user.username, 'test@example.com'));
    if (existing.length > 0) {
      console.log('User already exists, updating password...');
      await db.update(schema.user).set({ password: hashedPassword }).where(eq(schema.user.username, 'test@example.com'));
      return;
    }

    await db.insert(schema.user).values({
      username: 'test@example.com',
      password: hashedPassword,
      locale: 'en',
      operator: true,
      hasSeenWelcome: true, // Bypass welcome
      totpEnabled: false,
    });
    console.log('Hub User Seeded.');
  } catch (e) {
    console.error('Failed to seed hub user:', e);
    // We might fail if DB connection fails using localhost:6543
    // If test runs in docker, localhost refers to container?
    // No, Playwright runs on host. DB is mapped to 6543 on host.
    // It should work.
  }
}

function runSqlite(query: string) {
  const cmd = `sqlite3 "${LOCAL_DB_PATH}" "${query.replace(/"/g, '\\"')}"`;
  console.log(`Executing SQLite: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function runRemoteD1(query: string) {
  // Requires wrangler in path or pnpm
  try {
    // Escape double quotes in query
    const escapedQuery = query.replace(/"/g, '\\"');
    const cmd = `pnpm --silent wrangler d1 execute ci-cloud-db-staging --remote --json --command "${escapedQuery}"`;
    console.log(`Executing Remote D1: ${cmd}`);
    // use execSync to run command
    const output = execSync(cmd, { cwd: CLOUD_APP_DIR, encoding: 'utf-8' });
    console.log('Remote D1 Raw Output:', output.substring(0, 500) + '...');
        
    // Find all potential JSON arrays (Bracket Balancing)
    const candidates: string[] = [];
    let depth = 0;
    let start = -1;
    
    for (let i = 0; i < output.length; i++) {
        if (output[i] === '[') {
            if (depth === 0) start = i;
            depth++;
        } else if (output[i] === ']') {
            depth--;
            if (depth === 0 && start !== -1) {
                candidates.push(output.substring(start, i + 1));
                start = -1;
            }
        }
    }
    
    // Check candidates (reversed preference - check last one first as logs come before output usually)
    for (let i = candidates.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(candidates[i]);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') {
                 // Check if it looks like D1 output
                 if ('results' in parsed[0] || 'success' in parsed[0]) {
                     return parsed[0].results || [];
                 }
            }
        } catch (e) {}
    }
    
    console.warn('Remote D1: No valid JSON result found in output.');
    return [];
  } catch (error) {
    console.error('Remote D1 Execution Failed:', error.message);
    return [];
  }
}

// Modify ENV file helper
function updateEnvFile(updates: Record<string, string | undefined>) {
  let content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const newLines = [];
  const keysUpdated = new Set();

  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1];
      if (key in updates) {
        if (updates[key] !== undefined) {
          newLines.push(`${key}=${updates[key]}`);
          keysUpdated.add(key);
        }
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  // Append new keys
  for (const [key, val] of Object.entries(updates)) {
    if (!keysUpdated.has(key) && val !== undefined) {
      newLines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(ENV_PATH, newLines.join('\n'));
}

let cloudServerProcess;

test.describe('Full E2E: Injection & Provisioning (Local Cloud)', () => {
  test.setTimeout(300000); // 5 minutes

  test.beforeAll(async () => {
    // Kill any existing process on 8001
    try {
      console.log('Cleaning up port 8001...');
      execSync('lsof -t -i:8001 | xargs kill -9 || true');
    } catch (e) {
      // Ignore if no process
    }

    // 0. Clean leftover apps from DB to ensure fresh install
    console.log('Cleaning Hub DB apps...');
    try {
      await db.delete(schema.app);
    } catch (e) {
      console.error('Failed to clean apps db:', e);
    }

    if (IS_STAGING) {
      console.log('>>> RUNNING IN STAGING MODE <<<');
      console.log(`Targeting Device ID: ${TARGET_DEVICE_ID}`);

      // 1. Ensure Organization Exists
      console.log('Ensuring Staging Organization Exists...');
      const orgCheck = runRemoteD1(`SELECT id FROM organization WHERE id = '${TEST_ORG_ID}'`);
      if (orgCheck.length === 0) {
          console.log(`Creating Org: ${TEST_ORG_ID}`);
          runRemoteD1(`INSERT INTO organization (id, slug, name, created_at) VALUES ('${TEST_ORG_ID}', '${TEST_ORG_SLUG}', 'E2E Test Org', 1700000000000)`);
      }

      // 2. Ensure Device Exists
      console.log('Ensuring Staging Device Exists...');
      const devCheck = runRemoteD1(`SELECT device_id, api_key FROM device WHERE device_id = '${TARGET_DEVICE_ID}'`);
      if (devCheck.length === 0) {
          console.log(`Creating Device: ${TARGET_DEVICE_ID}`);
          runRemoteD1(`INSERT INTO device (device_id, api_key, status, created_at) VALUES ('${TARGET_DEVICE_ID}', '${TEST_API_KEY}', 'active', 1700000000000)`);
      } else {
          TEST_API_KEY = devCheck[0].api_key;
          console.log(`Using existing API Key for device: ${TEST_API_KEY}`);
      }
      
      // 3. Ensure Registration Exists
      console.log('Ensuring Device Registration Exists...');
      const regCheck = runRemoteD1(`SELECT id FROM device_registration WHERE device_id = '${TARGET_DEVICE_ID}' AND organization_id = '${TEST_ORG_ID}'`);
      if (regCheck.length === 0) {
          const regId = 'reg_' + Date.now();
          console.log(`Creating Registration: ${regId}`);
          runRemoteD1(`INSERT INTO device_registration (id, device_id, organization_id) VALUES ('${regId}', '${TARGET_DEVICE_ID}', '${TEST_ORG_ID}')`);
      }

      // 4. Clear existing Applications for this device in Staging to ensure clean state
      console.log('Cleaning Staging D1 Applications for this device...');
      runRemoteD1(`DELETE FROM application WHERE device_id = '${TARGET_DEVICE_ID}'`);

      // No Cloud Server Spawn
      return;
    }

    // Start Local Cloud Server
    console.log('Starting Local Cloud Server (pnpm run dev)...');
    // We use spawn to run it in background
    console.log('Creating Mock App Store (repo.zip)...');
    const repoDir = path.join(CLOUD_APP_DIR, 'temp_repo');
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });

    // 1. Mock PairDrop
    fs.mkdirSync(path.join(repoDir, 'apps', 'pairdrop', 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'apps', 'pairdrop', 'config.json'),
      JSON.stringify({
        id: 'pairdrop',
        name: 'PairDrop',
        version: '1.0.1',
        port: 8123,
        categories: ['utilities'],
        description: 'Local file sharing',
        short_desc: 'Local file sharing',
        available: true,
        tipi_version: 1,
        author: 'E2E Test',
        source: 'https://github.com/pairdrop/pairdrop',
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'apps', 'pairdrop', 'docker-compose.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          services: [
            {
              name: 'pairdrop',
              image: 'linuxserver/pairdrop',
              addPorts: [{ containerPort: 3000, hostPort: '${APP_PORT}' }],
              environment: [{ key: 'TZ', value: 'Etc/UTC' }],
              restart: 'unless-stopped',
            },
          ],
        },
        null,
        2,
      ),
    );

    // 2. Mock Cloudflared
    fs.mkdirSync(path.join(repoDir, 'apps', 'cloudflared', 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'apps', 'cloudflared', 'config.json'),
      JSON.stringify({
        id: 'cloudflared',
        name: 'Cloudflared',
        version: '1.0.0',
        port: 80,
        categories: ['utilities'],
        description: 'Cloudflare Tunnel',
        short_desc: 'Cloudflare Tunnel',
        available: true,
        tipi_version: 1,
        author: 'E2E Test',
        source: 'https://hub.docker.com/r/cloudflare/cloudflared',
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'apps', 'cloudflared', 'docker-compose.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          services: [
            {
              name: 'cloudflared',
              image: 'cloudflare/cloudflared:latest',
              command: 'tunnel run --token ${TUNNEL_TOKEN}',
              environment: [{ key: 'TUNNEL_ID', value: '${TUNNEL_ID}' }],
              restart: 'unless-stopped',
            },
          ],
        },
        null,
        2,
      ),
    );

    console.log('Written docker-compose.json files');

    // Zip it - Make sure zip command exists or use node
    try {
      // Target the protected folder served by the Hono app
      const protectedDir = path.resolve(CLOUD_APP_DIR, '../web-app/public/protected');
      if (!fs.existsSync(protectedDir)) fs.mkdirSync(protectedDir, { recursive: true });

      const zipPath = path.join(protectedDir, 'repo.zip');
      if (fs.existsSync(zipPath)) {
        fs.rmSync(zipPath);
        console.log('Removed old repo.zip');
      }
      execSync(`cd "${repoDir}" && zip -r "${zipPath}" .`);
      console.log(`Created new repo.zip at ${zipPath}`);
    } catch (e) {
      console.error('Failed to zip repo, app store might fail:', e);
    }

    cloudServerProcess = spawn('pnpm', ['run', 'dev'], {
      cwd: CLOUD_APP_DIR,
      stdio: 'inherit', // Pipe output to see server logs
      env: { ...process.env, PATH: process.env.PATH }, // Ensure path inherited
    });

    // Wait a bit for server to spin up
    await new Promise((r) => setTimeout(r, 5000));

    // 1. Clean & Seed Local Cloud DB
    console.log('Seeding Local Cloud DB...');
    // Clean if exists - Target the PERSISTENT Device ID
    try {
      runSqlite(`DELETE FROM organization WHERE slug = '${TEST_ORG_SLUG}'`);
      runSqlite(`DELETE FROM device WHERE device_id = '${TARGET_DEVICE_ID}'`);
      runSqlite(`DELETE FROM device_registration WHERE device_id = '${TARGET_DEVICE_ID}'`);
      runSqlite(`DELETE FROM application`); // Clean applications
    } catch (e) {}

    // Insert Org
    runSqlite(
      `INSERT INTO organization (id, slug, name, created_at) VALUES ('${TEST_ORG_ID}', '${TEST_ORG_SLUG}', 'E2E Test Org', strftime('%s', 'now') * 1000)`,
    );

    // Insert Device (The Key matches what we inject into Hub)
    runSqlite(
      `INSERT INTO device (device_id, api_key, status, created_at) VALUES ('${TARGET_DEVICE_ID}', '${TEST_API_KEY}', 'active', strftime('%s', 'now'))`,
    );

    // Insert Registration (Links Device to Org)
    const regId = 'reg_' + Date.now();
    runSqlite(`INSERT INTO device_registration (id, device_id, organization_id) VALUES ('${regId}', '${TARGET_DEVICE_ID}', '${TEST_ORG_ID}')`);

    // 2. Clean Local Hub State (Remove Auth Keys from .env)
    console.log('Cleaning Local Hub State...');
    // Strict Remove
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    content = content
      .split('\n')
      .filter((l) => !l.startsWith('CI_HUB_ORGANIZATION_ID=') && !l.startsWith('CI_HUB_API_KEY='))
      .join('\n');
    fs.writeFileSync(ENV_PATH, content);

    // Also Clean settings.json to prevent overriding .env
    try {
      const settingsPath = path.join(__dirname, '../.internal/state/settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        // Remove keys if they exist
        if (settings.ciHubApiKey) delete settings.ciHubApiKey;
        if (settings.ciHubOrganizationId) delete settings.ciHubOrganizationId;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('Cleaned settings.json (removed Auth Keys)');
      }
    } catch (e) {
      console.error('Failed to clean settings.json', e);
    }

    console.log('Restarting Hub (Clean)...');
    execSync('docker restart ci-os-hub');

    // Wait for health
    console.log('Waiting for Hub Health...');
    await waitForHealth();
  });

  test('Authenticate via Backend Injection and Provision App', async ({ page, request: apiRequest }) => {
    page.on('console', (msg) => console.log('BROWSER LOG:', msg.text()));
    page.on('response', (response) => {
      if (response.status() >= 400) console.log(`<< ${response.status()} ${response.url()}`);
    });

    // --- STEP 1: Inject Credentials ---
    console.log('Injecting Credentials...');
    // We rely on default CI_CLOUD_APP_STORE_URL pointing to local cloud 8001

    const envUpdates = {
      CI_HUB_ORGANIZATION_ID: TEST_ORG_ID,
      CI_HUB_API_KEY: TEST_API_KEY,
      DEVICE_ID: TARGET_DEVICE_ID,
    };

    if (!IS_STAGING) {
      // For Local, ensure URL uses host.docker.internal for Hub->Host access
      envUpdates['CI_CLOUD_APP_STORE_URL'] = 'http://host.docker.internal:8001/api/web/download-app-store';
    }

    updateEnvFile(envUpdates);

    // --- STEP 2: Restart Hub ---
    console.log('Restarting Hub with Credentials...');
    execSync('docker restart ci-os-hub');
    await waitForHealth();

    // Seed User
    await seedHubUser();

    // --- STEP 3: Verify Dashboard & App Store Access ---
    console.log('Navigating to Dashboard...');

    // Force fresh login (Server restart cleared in-memory sessions)
    await page.context().clearCookies();
    await page.goto(HUB_URL);

    // Handling Login logic
    if (page.url().includes('/register')) {
      console.log('Registering Local User...');
      await page.getByPlaceholder('Email').fill('test@example.com');
      await page.getByPlaceholder('Password').fill('password123');
      await page.getByRole('button', { name: 'Register' }).click();
      await page.waitForURL(/\/dashboard|\/welcome/);
    } else {
      // Likely /login
      console.log('Logging in...');
      await page.locator('input[name="email"]').fill('test@example.com');
      await page.locator('input[name="password"]').fill('password123');
      await page.locator('button[type="submit"]').click();
      try {
        await page.waitForURL(/\/dashboard/, { timeout: 15000 });
      } catch (e) {
        console.log('Login wait failed. Current URL:', page.url());
        console.log('Page Content Snippet:', (await page.content()).slice(0, 1000));
        throw e;
      }
    }

    console.log('Checking App Store access...');
    await page.goto(`${HUB_URL}/app-store`);

    console.log(`Current URL: ${page.url()}`);

    const appId = 'cloudflared'; // Defined here for scope visibility

    // Check for 500
    const bodyText = await page.locator('body').textContent();
    if (bodyText?.includes('Internal Server Error')) {
      throw new Error('App Store returned 500 Internal Server Error - Local Cloud might be down or unreachable');
    }

    // Soft check for Search
    const searchVisible = await page.getByPlaceholder('Search').isVisible({ timeout: 5000 });
    if (!searchVisible) {
      console.log('Warning: Search bar not visible.');
    }

    // --- STEP 4: Provision Tunnel (Install App) ---
    console.log('Attempting to install Cloudflared Tunnel (or fallback)...');

    let installedViaUI = false;
    let appIdToInstall = appId;

    if (searchVisible) {
      // Try UI Search
      await page.getByPlaceholder('Search').fill('cloudflared');
      try {
        const installBtn = page.getByRole('button', { name: 'Install' }).first();
        if (await installBtn.isVisible({ timeout: 5000 })) {
          await installBtn.click();
          console.log('Clicked Install in UI');
          installedViaUI = true;
        }
      } catch (e) {
        console.log('UI Find/Click failed');
      }
    }

    if (!installedViaUI) {
      console.log('Using API Fallback for Install...');

      // Debug: Check enabled stores
      let dynamicStoreId = 'ci-cloud';
      try {
        const storesRes = await page.request.get(`${HUB_URL}/api/marketplace/enabled`);
        const stores = await storesRes.json();
        console.log('Enabled App Stores:', JSON.stringify(stores, null, 2));
        if (stores.appStores && stores.appStores.length > 0) {
          // API returns 'slug' not 'id'
          const target = stores.appStores.find((s: any) => s.slug !== 'migrated') || stores.appStores[0];
          if (target) dynamicStoreId = target.slug;
        }
      } catch (e) {
        console.log('Failed to list stores', e);
      }

      // Sync App Stores to ensure they are up to date
      console.log('Force syncing app stores...');
      try {
        const syncRes = await page.request.post(`${HUB_URL}/api/marketplace/pull`, { data: {} });
        console.log('Sync result:', syncRes.status());
      } catch (e) {
        console.log('Sync failed:', e);
      }

      // Search for app to get correct URN
      appIdToInstall = appId;
      try {
        // Wait a moment for indexing
        await page.waitForTimeout(2000);

        const searchRes = await page.request.get(`${HUB_URL}/api/marketplace/apps/search?search=${appId}`);
        if (searchRes.ok()) {
          const searchJson = await searchRes.json();
          console.log('Search Results:', JSON.stringify(searchJson, null, 2));
          const foundApp = Array.isArray(searchJson) ? searchJson[0] : searchJson.apps ? searchJson.apps[0] : null;
          if (foundApp && foundApp.id) {
            appIdToInstall = foundApp.id;
            console.log(`Resolved App URN: ${appIdToInstall}`);
          }
        }
      } catch (e) {
        console.log('Search for URN failed, using default:', e);
      }

      // Fallback default if search failed
      if (appIdToInstall === appId) {
        appIdToInstall = `${appId}:${dynamicStoreId}`;
        console.log('Using guessed URN:', appIdToInstall);
      }

      // Use page.request to share session cookies
      const response = await page.request.post(`${HUB_URL}/api/app-lifecycle/${appIdToInstall}/install`, {
        data: {},
      });

      if (response.ok()) {
        console.log(`App ${appIdToInstall} install triggered via API`);
      } else {
        console.log('API Install failed:', response.status(), await response.text());
      }
    }

    // Wait for Installation - Verify via API
    console.log('Waiting for installation (verifying via API)...');

    let isInstalled = false;
    for (let i = 0; i < 45; i++) {
      // Increase timeout to 90s
      const res = await page.request.get(`${HUB_URL}/api/apps/installed`);
      if (res.ok()) {
        const json = await res.json();
        const installedApps = json.installed || [];

        if (i % 5 === 0) console.log(`[${i}] Installed count:`, installedApps.length);

        // Check for appId or URN (Data structure is { app, info, metadata })
        const found = installedApps.find((item: any) => {
          const info = item.info || {};
          const app = item.app || {};
          return info.id === appId || info.urn === appIdToInstall || app.appName === appId || info.name?.toLowerCase().includes(appId);
        });

        // Also check status
        if (found) {
          const status = found.app?.status; // Status is in app object
          if (status === 'running') {
            isInstalled = true;
            console.log(`App found running: ${found.info?.id || found.app?.id}`);
            break;
          } else {
            if (i % 5 === 0) console.log(`App found but status is ${status}`);
          }
        }
      }
      await page.waitForTimeout(2000);
    }

    if (!isInstalled) {
      throw new Error(`App ${appId} failed to install (not found in /api/v1/apps/installed)`);
    }

    console.log('Tunnel App Installed Successfully (Verified via API).');

    // --- STEP 5: Provision App (PairDrop) to verify Application Sync ---
    console.log('Installing PairDrop (Exposed) to verify Cloud Sync...');

    // 1. Search/Find PairDrop
    let pairdropUrn = 'pairdrop:ci-cloud';
    try {
      const searchRes = await page.request.get(`${HUB_URL}/api/marketplace/apps/search?search=pairdrop`);
      if (searchRes.ok()) {
        const searchJson = await searchRes.json();
        const foundApp = Array.isArray(searchJson) ? searchJson[0] : searchJson.apps ? searchJson.apps[0] : null;
        if (foundApp && foundApp.id) {
          pairdropUrn = foundApp.id;
          console.log(`Resolved PairDrop URN: ${pairdropUrn}`);
        }
      }
    } catch (e) {}

    // 2. Install PairDrop with exposedLocal=true
    const installRes = await page.request.post(`${HUB_URL}/api/app-lifecycle/${pairdropUrn}/install`, {
      data: {
        exposedLocal: true, // This should trigger cloud sync
        localSubdomain: `pairdrop-e2e-${TEST_ORG_SLUG}`,
        port: 3005, // Avoid port 3000 which is used by Hub
      },
    });
    expect(installRes.status()).toBe(201); // Or 200

    // 3. Wait for PairDrop running
    console.log('Waiting for PairDrop installation...');
    let pairdropInstalled = false;
    for (let i = 0; i < 45; i++) {
      const res = await page.request.get(`${HUB_URL}/api/apps/installed`);
      if (res.ok()) {
        const json = await res.json();
        const installedApps = json.installed || [];
        const found = installedApps.find((item: any) => item.app?.appName === 'pairdrop' && item.app?.status === 'running');
        if (found) {
          pairdropInstalled = true;
          console.log('PairDrop found running.');
          break;
        }
      }
      await page.waitForTimeout(2000);
    }

    if (!pairdropInstalled) throw new Error('PairDrop failed to install');

    // 4. Verify Cloud DB has the application
    console.log('Verifying Cloud DB contains application record...');
    try {
      // Polling for Sync
      for (let k = 0; k < 15; k++) {
        let count = 0;
        if (IS_STAGING) {
          const results = runRemoteD1(`SELECT count(*) as count FROM application WHERE slug = 'pairdrop-e2e-${TEST_ORG_SLUG}' AND device_id = '${TARGET_DEVICE_ID}'`);
          count = results[0]?.count || 0;
        } else {
          const results = execSync(`sqlite3 "${LOCAL_DB_PATH}" "SELECT count(*) FROM application WHERE slug = 'pairdrop-e2e-${TEST_ORG_SLUG}'"`).toString().trim();
          count = parseInt(results);
        }

        if (count > 0) {
          console.log('Cloud DB Verified: Application Sync Success!');
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error('Cloud DB Verification Failed', e);
      throw e;
    }

    // 5. STAGING ONLY: Verify Tunnel Public Access
    if (IS_STAGING) {
      console.log('Verifying Public Tunnel Access...');
      // Construct URL: localSubdomain + .ci.computer (Staging domain)
      const publicUrl = `https://pairdrop-e2e-${TEST_ORG_SLUG}.ci.computer`;
      console.log(`Checking URL: ${publicUrl}`);

      // Retry loop for tunnel propagation
      let accessSuccess = false;
      for (let t = 0; t < 20; t++) {
        try {
          const response = await page.request.get(publicUrl);
          if (response.status() === 200) {
            const body = await response.text();
            if (body.includes('PairDrop')) {
              console.log('Tunnel Access Verified! Public URL is working.');
              accessSuccess = true;
              break;
            }
          }
          console.log(`Access attempt ${t + 1}: Status ${response.status()}`);
        } catch (err) {
          console.log(`Access attempt ${t + 1}: Error ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Critical Failure if Staging Tunnel doesn't work
      if (!accessSuccess) {
        throw new Error(`Failed to access public tunnel URL: ${publicUrl}`);
      }
    }
  });

  test.afterAll(async () => {
    // Cleanup Local Cloud Server
    if (cloudServerProcess) {
      console.log('Killing Local Cloud Server...');
      cloudServerProcess.kill();
    }
    // Cleanup SQLite ? Optional.
  });
});

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${HUB_URL}/api/health`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Backend connect timeout');
}
