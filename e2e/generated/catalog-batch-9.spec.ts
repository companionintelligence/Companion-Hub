
/**
 * Auto-generated app catalog tests for server batch 9
 * Generated: 2026-08-03T06:03:25.011Z
 * Apps: 46
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "stash",
    "storeSlug": "ci-apps",
    "name": "Stash",
    "expectedPort": 8805,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "steam-mcp",
    "storeSlug": "ci-apps",
    "name": "Steam MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "data",
      "utilities"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "stirling-pdf",
    "storeSlug": "ci-apps",
    "name": "Stirling-PDF",
    "expectedPort": 8234,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "stunnel",
    "storeSlug": "ci-apps",
    "name": "stunnel",
    "expectedPort": 18876,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "security",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "super-productivity",
    "storeSlug": "ci-apps",
    "name": "Super Productivity",
    "expectedPort": 8806,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "sure",
    "storeSlug": "ci-apps",
    "name": "Sure",
    "expectedPort": 8807,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "surfsense",
    "storeSlug": "ci-apps",
    "name": "SurfSense",
    "expectedPort": 8259,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "data",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "synapse",
    "storeSlug": "ci-apps",
    "name": "Synapse",
    "expectedPort": 8809,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "syncthing",
    "storeSlug": "ci-apps",
    "name": "Syncthing",
    "expectedPort": 8384,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "tandoor",
    "storeSlug": "ci-apps",
    "name": "Tandoor Recipes",
    "expectedPort": 18823,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "taxhacker",
    "storeSlug": "ci-apps",
    "name": "TaxHacker",
    "expectedPort": 7331,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "teable",
    "storeSlug": "ci-apps",
    "name": "Teable",
    "expectedPort": 8925,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "teampass",
    "storeSlug": "ci-apps",
    "name": "TeamPass",
    "expectedPort": 18881,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "telegrapho",
    "storeSlug": "ci-apps",
    "name": "Telegrapho",
    "expectedPort": 8811,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "thelounge",
    "storeSlug": "ci-apps",
    "name": "The Lounge",
    "expectedPort": 8813,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "thinkdashboard",
    "storeSlug": "ci-apps",
    "name": "ThinkDashboard",
    "expectedPort": 8814,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "threema",
    "storeSlug": "ci-apps",
    "name": "Threema Web",
    "expectedPort": 8815,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "tor",
    "storeSlug": "ci-apps",
    "name": "Tor",
    "expectedPort": 9050,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "security",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "torbrowser",
    "storeSlug": "ci-apps",
    "name": "Tor Browser",
    "expectedPort": 8816,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "transmission",
    "storeSlug": "ci-apps",
    "name": "Transmission",
    "expectedPort": 18906,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "transmute",
    "storeSlug": "ci-apps",
    "name": "Transmute",
    "expectedPort": 8817,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "trek",
    "storeSlug": "ci-apps",
    "name": "TREK",
    "expectedPort": 18925,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "trilium-notes",
    "storeSlug": "ci-apps",
    "name": "Trilium Notes",
    "expectedPort": 8818,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "triliumnext",
    "storeSlug": "ci-apps",
    "name": "TriliumNext",
    "expectedPort": 18902,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "trip",
    "storeSlug": "ci-apps",
    "name": "TRIP",
    "expectedPort": 8245,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "twenty",
    "storeSlug": "ci-apps",
    "name": "Twenty",
    "expectedPort": 2020,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "unity-mcp",
    "storeSlug": "ci-apps",
    "name": "Unity MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "valorgrid",
    "storeSlug": "ci-apps",
    "name": "ValorGrid",
    "expectedPort": 8820,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "vane",
    "storeSlug": "ci-apps",
    "name": "Vane",
    "expectedPort": 7458,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "veloren",
    "storeSlug": "ci-apps",
    "name": "Veloren Server",
    "expectedPort": 14004,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "gaming"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "vitriol",
    "storeSlug": "ci-apps",
    "name": "Vitriol",
    "expectedPort": 8390,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wallos",
    "storeSlug": "ci-apps",
    "name": "Wallos",
    "expectedPort": 8222,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wanderer",
    "storeSlug": "ci-apps",
    "name": "Wanderer",
    "expectedPort": 8823,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wealthfolio",
    "storeSlug": "ci-apps",
    "name": "Wealthfolio",
    "expectedPort": 8824,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "webcheck",
    "storeSlug": "ci-apps",
    "name": "WebCheck",
    "expectedPort": 8825,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wewe-rss",
    "storeSlug": "ci-apps",
    "name": "WeWe RSS",
    "expectedPort": 18893,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "whisper-webui",
    "storeSlug": "ci-apps",
    "name": "Whisper-WebUI",
    "expectedPort": 18938,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "whisperx-fastapi",
    "storeSlug": "ci-apps",
    "name": "WhisperX FastAPI",
    "expectedPort": 18944,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "windows",
    "storeSlug": "ci-apps",
    "name": "Windows",
    "expectedPort": 8006,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wingfit",
    "storeSlug": "ci-apps",
    "name": "Wingfit",
    "expectedPort": 8827,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "wordpress",
    "storeSlug": "ci-apps",
    "name": "WordPress",
    "expectedPort": 8213,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "worldmonitor",
    "storeSlug": "ci-apps",
    "name": "World Monitor",
    "expectedPort": 8410,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "yuvomi",
    "storeSlug": "ci-apps",
    "name": "Yuvomi",
    "expectedPort": 8829,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "zen",
    "storeSlug": "ci-apps",
    "name": "Zen",
    "expectedPort": 8830,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "zeronote",
    "storeSlug": "ci-apps",
    "name": "ZeroNote",
    "expectedPort": 8831,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "zima",
    "storeSlug": "ci-apps",
    "name": "ZimaOS",
    "expectedPort": 18865,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 9', () => {
  for (const app of APPS) {
    // One test per app so install -> access -> cleanup share a single Hub/DB state.
    // The custom `page` fixture resets the backend DB the first time it is used, so
    // splitting these into separate tests wiped the install record (and left the Docker
    // deployment behind) before access/cleanup ran.
    test(`App: ${app.name}`, async ({ page, context }) => {
      await loginUser(page, context);

      // Install
      await page.goto(`/app-store/${app.storeSlug}/${app.id}`);
      await page.getByRole('button', { name: 'Install' }).click();
      await expect(page.getByText(/running|installed/i)).toBeVisible({ timeout: 180000 });

      // Access via subdomain (GUI apps only) + screenshot for evidence
      if (app.hasGui) {
        const subdomain = `test-${app.id}`;
        const url = `https://${subdomain}.${process.env.TEST_DOMAIN || 'test.ci.computer'}${app.healthEndpoint}`;
        const appPage = await context.newPage();
        const response = await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        expect(response?.status()).toBeLessThan(500);
        await appPage.screenshot({ path: `./e2e/screenshots/catalog/${app.id}.png`, fullPage: true });
        await appPage.close();
      }

      // Cleanup (uninstall) — the same state that performed the install
      await page.goto(`/apps/${app.id}`);
      await page.getByRole('button', { name: /delete|uninstall/i }).click();
      await page.getByRole('button', { name: /confirm/i }).click();
      await expect(page.getByText(/deleted|removed/i)).toBeVisible({ timeout: 60000 });
    });
  }
});
