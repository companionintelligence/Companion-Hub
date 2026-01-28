import { join, basename } from 'node:path';
import { createHmac } from 'node:crypto';

// --- Configuration ---
const API_URL = 'http://localhost:3000/api';
const JWT_SECRET = '857ad2225d62961ba24b12ee88b4a628e1647a0c61d5113f313f56f22461d0c3'; // From local container

// --- Helpers ---

// biome-ignore lint/suspicious/noExplicitAny: generic payload
function signJwt(payload: any, secret: string) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const AUTH_TOKEN = signJwt({ sub: 'cli' }, JWT_SECRET);

// biome-ignore lint/suspicious/noExplicitAny: generic body
async function apiRequest(method: string, endpoint: string, body?: any) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API Error ${response.status}: ${text}`);
    }
    return await response.json();
  } catch (error) {
    // biome-ignore lint/suspicious/noExplicitAny: error typing
    throw new Error(`Request failed: ${(error as any).message}`);
  }
}

async function checkSystemRequirements(verbose = false) {
  if (verbose) console.log('Checking system requirements...');
  // Use /system/load as a health/auth check
  try {
    await apiRequest('GET', '/system/load');
    if (verbose) console.log('System API is accessible and authenticated.');
  } catch (e) {
    console.error('Failed to connect to CI-OS-Hub API. Ensure it is running locally on port 3000.');
    console.error(e);
    process.exit(1);
  }
}

async function getInstalledApps() {
  try {
    const res = await apiRequest('GET', '/apps/installed');
    // biome-ignore lint/suspicious/noExplicitAny: response structure unknown
    return (res as any).installed || [];
  } catch (e) {
    // biome-ignore lint/suspicious/noExplicitAny: error typing
    console.warn('Failed to get installed apps, assuming none.', (e as any).message);
    return [];
  }
}

async function checkAppStatus(appId: string) {
  // Wait for app to be running
  let retries = 30; // Increased retries since install can be slow
  while (retries > 0) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: response unknown
      const app: any = await apiRequest('GET', `/apps/${appId}`);
      // Check top level status or nested app.status
      const status = app.status || app.app?.status || 'unknown';

      if (status === 'unknown') {
        console.log(`\nDEBUG: Full app response: ${JSON.stringify(app)}`);
      }

      if (status === 'running') {
        console.log(`\n${appId} is running!`);
        return true;
      }
      if (status === 'error' || status === 'stopped') {
        console.log(`\n${appId} status: ${status}`);
        // Consider stopped as success for CLI tools if they ran and exited?
        // But typically running services stay running.
        // For now, let's assume they should reach 'running' unless it's a job.
        // If it's effectively verified as *installed* and *tried to start*, maybe we allow it.
        // But usually verify-app implies successful start.
        return status === 'running';
      }
      process.stdout.write(` [${status}] `);
    } catch (_e) {
      // Ignore 404/errors during startup
      process.stdout.write('?');
    }
    await new Promise((r) => setTimeout(r, 2000));
    retries--;
  }
  console.error(`\nTimeout waiting for ${appId} to start.`);
  return false;
}

async function uninstallApp(id: string, originalName: string) {
  console.log(`Uninstalling ${id}...`);
  try {
    // Try ID first
    try {
      await apiRequest('DELETE', `/app-lifecycle/${id}/uninstall`, { removeBackups: true });
      console.log(`Uninstalled ${id}`);
      return;
    } catch (_e) {
      // ignore
    }

    // Try with namespace
    await apiRequest('DELETE', `/app-lifecycle/${originalName}:migrated/uninstall`, { removeBackups: true });
    console.log(`Uninstalled ${originalName}:migrated`);
  } catch (e) {
    // biome-ignore lint/suspicious/noExplicitAny: error typing
    console.error(`Failed to uninstall ${id}:`, (e as any).message);
  }
}

async function registerUser() {
  // console.log("Attempting to register default admin...");
  try {
    await apiRequest('POST', '/auth/register', {
      username: 'admin@example.com',
      password: 'password123',
      confirmPassword: 'password123',
    });
    // console.log("Registered default admin.");
  } catch (_e) {
    // Ignore
  }
}

async function checkWebInterface(port: number, appName: string): Promise<boolean> {
  const url = `http://localhost:${port}`;
  console.log(`Checking web interface at ${url}...`);

  let retries = 10;
  while (retries > 0) {
    try {
      // Abort signal for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow', // Follow redirects (e.g. keycloak/authelia often redirect)
      });
      clearTimeout(timeoutId);

      console.log(`HTTP ${res.status} from ${url}`);

      // Accept 2xx, 3xx, and 401/403 (auth required generally means app is up)
      if (res.status >= 200 && res.status < 500) {
        const text = await res.text();

        // Generic broken checks
        if (text.includes('Welcome to nginx!') && !appName.includes('nginx')) {
          console.warn('Usage: Detected default Nginx page, possible misconfiguration.');
        }

        // Specific "silently failed" check requested by user
        const lowerText = text.toLowerCase();
        if (
          lowerText.includes('internal server error') ||
          lowerText.includes('502 bad gateway') ||
          text.includes('The build failed because the process exited too early')
        ) {
          console.error('Content contained error indicators.');
          return false;
        }

        return true;
      }
    } catch (_e) {
      // Connection refused - app might still be starting web server
      process.stdout.write('.');
    }
    await new Promise((r) => setTimeout(r, 2000));
    retries--;
  }
  console.error(`Failed to reach web interface at ${url} after retries.`);
  return false;
}

// --- Main ---

async function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Usage: bun verify-app <path-to-app-folder>');
    process.exit(1);
  }

  // Extract app name from path.
  // Example: ../CI-App-Store/apps/chantools -> chantools
  const appName = basename(appPath);

  console.log(`Starting Validation for app: ${appName} (from ${appPath})`);

  // Ensure we are connected
  await checkSystemRequirements(false);
  await registerUser();

  console.log(`\n--- Testing ${appName} ---`);

  // 1. Install
  console.log(`Installing ${appName}...`);
  try {
    // We assume the app is already available in the 'migrated' store (mapped volume)
    // If the user points to a folder outside of the mapped store, this will fail or install the wrong thing.
    // For this specific workspace setup, we trust the user maps it correctly.
    await apiRequest('POST', `/app-lifecycle/${appName}:migrated/install`, {});
    console.log(`Installation trigger successful for ${appName}`);
  } catch (e) {
    // biome-ignore lint/suspicious/noExplicitAny: error typing
    console.error(`Failed to trigger install for ${appName}: ${(e as any).message}`);
    console.error("Ensure the app exists in the 'migrated' repo (CI-App-Store/apps).");
    process.exit(1);
  }

  // 2. Verify Status
  let installedId = appName;
  await new Promise((r) => setTimeout(r, 2000));

  let success = false;
  try {
    const installedApps = await getInstalledApps();
    // biome-ignore lint/suspicious/noExplicitAny: generic matching
    const found = installedApps.find((i: any) => i.app?.appName === appName || i.info?.urn?.includes(appName));
    if (found) {
      installedId = found.info.urn;
      console.log(`App installed as ID: ${installedId} (DB ID: ${found.app.id})`);
    } else {
      console.log('App not found in installed list immediately after trigger. Waiting...');
    }

    success = await checkAppStatus(installedId);
  } catch (e) {
    console.error('Error during status check loop:', e);
  }

  // 2.5 Verify Web Interface
  if (success) {
    try {
      const configPath = join(appPath, 'config.json');
      const configFile = Bun.file(configPath);
      if (await configFile.exists()) {
        const configParams = await configFile.json();
        if (configParams.port) {
          success = await checkWebInterface(configParams.port, appName);
        } else {
          console.log('No port defined in config.json, skipping web check.');
        }
      } else {
        console.warn(`config.json not found at ${configPath}`);
      }
    } catch (e) {
      // biome-ignore lint/suspicious/noExplicitAny: error typing
      console.warn('Could not read config.json for port check.', (e as any).message);
    }
  }

  // 3. Uninstall (clean up)
  await uninstallApp(installedId, appName);

  if (success) {
    console.log(`>>> SUCCESS: ${appName} validated.`);
    process.exit(0);
  } else {
    console.error(`>>> FAILED: ${appName} did not start correctly.`);
    process.exit(1);
  }
}

main();
