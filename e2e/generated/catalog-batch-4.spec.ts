
/**
 * Auto-generated app catalog tests for server batch 4
 * Generated: 2026-08-19T00:34:24.589Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "cyberchef",
    "storeSlug": "ci-apps",
    "name": "CyberChef",
    "expectedPort": 18850,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "cypht",
    "storeSlug": "ci-apps",
    "name": "Cypht",
    "expectedPort": 8077,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "databag",
    "storeSlug": "ci-apps",
    "name": "Databag",
    "expectedPort": 8716,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "databunker",
    "storeSlug": "ci-apps",
    "name": "Databunker",
    "expectedPort": 53237,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "datasette",
    "storeSlug": "ci-apps",
    "name": "Datasette",
    "expectedPort": 53083,
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
    "id": "dawarich",
    "storeSlug": "ci-apps",
    "name": "Dawarich",
    "expectedPort": 53122,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "deepseek-ocr-webui",
    "storeSlug": "ci-apps",
    "name": "DeepSeek-OCR-WebUI",
    "expectedPort": 8001,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "deerflow",
    "storeSlug": "ci-apps",
    "name": "DeerFlow",
    "expectedPort": 2026,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "agents",
      "ai",
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "defguard",
    "storeSlug": "ci-apps",
    "name": "Defguard",
    "expectedPort": 53198,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "degoog",
    "storeSlug": "ci-apps",
    "name": "Degoog",
    "expectedPort": 4444,
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
    "id": "deluge",
    "storeSlug": "ci-apps",
    "name": "Deluge",
    "expectedPort": 8112,
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
    "id": "dittofeed",
    "storeSlug": "ci-apps",
    "name": "Dittofeed",
    "expectedPort": 53310,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "dnsmasq",
    "storeSlug": "ci-apps",
    "name": "dnsmasq",
    "expectedPort": 18863,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "docat",
    "storeSlug": "ci-apps",
    "name": "Docat",
    "expectedPort": 53311,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "docmost",
    "storeSlug": "ci-apps",
    "name": "Docmost",
    "expectedPort": 3040,
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
    "id": "documenso",
    "storeSlug": "ci-apps",
    "name": "Documenso",
    "expectedPort": 8319,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "docuseal",
    "storeSlug": "ci-apps",
    "name": "Docuseal",
    "expectedPort": 5341,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "dolibarr",
    "storeSlug": "ci-apps",
    "name": "Dolibarr",
    "expectedPort": 53148,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "domain-locker",
    "storeSlug": "ci-apps",
    "name": "Domain Locker",
    "expectedPort": 8717,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "domjudge",
    "storeSlug": "ci-apps",
    "name": "DOMjudge",
    "expectedPort": 53312,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "donetick",
    "storeSlug": "ci-apps",
    "name": "Donetick",
    "expectedPort": 8718,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "doordash-mcp",
    "storeSlug": "ci-apps",
    "name": "DoorDash MCP Server",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "network",
      "utilities"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "dropgate",
    "storeSlug": "ci-apps",
    "name": "Dropgate",
    "expectedPort": 8395,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "dtan-server",
    "storeSlug": "ci-apps",
    "name": "DTAN Server",
    "expectedPort": 8719,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "dub",
    "storeSlug": "ci-apps",
    "name": "Dub",
    "expectedPort": 18832,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "dumbpad",
    "storeSlug": "ci-apps",
    "name": "DumbPad",
    "expectedPort": 8720,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "duplicati",
    "storeSlug": "ci-apps",
    "name": "Duplicati",
    "expectedPort": 18877,
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
    "id": "ech0",
    "storeSlug": "ci-apps",
    "name": "Ech0",
    "expectedPort": 53220,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "elabftw",
    "storeSlug": "ci-apps",
    "name": "eLabFTW",
    "expectedPort": 53245,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "electrs",
    "storeSlug": "ci-apps",
    "name": "Electrs (Electrum Server)",
    "expectedPort": 50001,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "finance",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "element",
    "storeSlug": "ci-apps",
    "name": "Element",
    "expectedPort": 8088,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "embeddinggemma",
    "storeSlug": "ci-apps",
    "name": "EmbeddingGemma",
    "expectedPort": 8090,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "enclosed",
    "storeSlug": "ci-apps",
    "name": "Enclosed",
    "expectedPort": 8723,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "endurain",
    "storeSlug": "ci-apps",
    "name": "Endurain",
    "expectedPort": 8724,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "espial",
    "storeSlug": "ci-apps",
    "name": "Espial",
    "expectedPort": 53313,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "espocrm",
    "storeSlug": "ci-apps",
    "name": "EspoCRM",
    "expectedPort": 8922,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ethercalc",
    "storeSlug": "ci-apps",
    "name": "EtherCalc",
    "expectedPort": 18860,
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
    "id": "etherpad",
    "storeSlug": "ci-apps",
    "name": "Etherpad",
    "expectedPort": 8726,
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
    "id": "evcc",
    "storeSlug": "ci-apps",
    "name": "evcc",
    "expectedPort": 53156,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ever-teams",
    "storeSlug": "ci-apps",
    "name": "Ever Teams",
    "expectedPort": 53397,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "evershop",
    "storeSlug": "ci-apps",
    "name": "EverShop",
    "expectedPort": 53121,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "excalidraw",
    "storeSlug": "ci-apps",
    "name": "Excalidraw",
    "expectedPort": 4422,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "excalidraw-mcp",
    "storeSlug": "ci-apps",
    "name": "Excalidraw MCP",
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
    "id": "expenseowl",
    "storeSlug": "ci-apps",
    "name": "ExpenseOwl",
    "expectedPort": 53238,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ezbookkeeping",
    "storeSlug": "ci-apps",
    "name": "ezBookkeeping",
    "expectedPort": 53102,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "farmos",
    "storeSlug": "ci-apps",
    "name": "farmOS",
    "expectedPort": 53252,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fast-note-sync",
    "storeSlug": "ci-apps",
    "name": "Fast Note Sync",
    "expectedPort": 18905,
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
    "id": "faved",
    "storeSlug": "ci-apps",
    "name": "Faved",
    "expectedPort": 53258,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fedimint",
    "storeSlug": "ci-apps",
    "name": "Fedimint",
    "expectedPort": 8175,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fetch-mcp",
    "storeSlug": "ci-apps",
    "name": "Fetch MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "network"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "file-browser",
    "storeSlug": "ci-apps",
    "name": "File Browser",
    "expectedPort": 7421,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "filegator",
    "storeSlug": "ci-apps",
    "name": "FileGator",
    "expectedPort": 53302,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "filerise",
    "storeSlug": "ci-apps",
    "name": "FileRise",
    "expectedPort": 53355,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "filestash",
    "storeSlug": "ci-apps",
    "name": "Filestash",
    "expectedPort": 53088,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "filesystem-mcp",
    "storeSlug": "ci-apps",
    "name": "Filesystem MCP",
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
    "id": "firefly-iii",
    "storeSlug": "ci-apps",
    "name": "Firefly III",
    "expectedPort": 18871,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fireflyiii",
    "storeSlug": "ci-apps",
    "name": "Firefly III",
    "expectedPort": 18948,
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
    "id": "firefox",
    "storeSlug": "ci-apps",
    "name": "Firefox",
    "expectedPort": 18919,
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
    "id": "fish-speech",
    "storeSlug": "ci-apps",
    "name": "Fish Speech",
    "expectedPort": 18932,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fish-speech-cpu",
    "storeSlug": "ci-apps",
    "name": "Fish Speech (CPU)",
    "expectedPort": 18979,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fizzy",
    "storeSlug": "ci-apps",
    "name": "Fizzy",
    "expectedPort": 8728,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "flaresolverr",
    "storeSlug": "ci-apps",
    "name": "FlareSolverr",
    "expectedPort": 8191,
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
    "id": "flatnotes",
    "storeSlug": "ci-apps",
    "name": "Flatnotes",
    "expectedPort": 8730,
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
    "id": "flowise",
    "storeSlug": "ci-apps",
    "name": "Flowise",
    "expectedPort": 18927,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fluidd",
    "storeSlug": "ci-apps",
    "name": "Fluidd",
    "expectedPort": 53287,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "focalboard",
    "storeSlug": "ci-apps",
    "name": "Focalboard",
    "expectedPort": 18897,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "formance",
    "storeSlug": "ci-apps",
    "name": "Formance",
    "expectedPort": 53401,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "formbricks",
    "storeSlug": "ci-apps",
    "name": "Formbricks",
    "expectedPort": 18888,
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
    "id": "fossbilling",
    "storeSlug": "ci-apps",
    "name": "FOSSBilling",
    "expectedPort": 53339,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "fredy",
    "storeSlug": "ci-apps",
    "name": "Fredy",
    "expectedPort": 53244,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "freepbx",
    "storeSlug": "ci-apps",
    "name": "FreePBX",
    "expectedPort": 18847,
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
    "id": "freeter",
    "storeSlug": "ci-apps",
    "name": "Freeter",
    "expectedPort": 8989,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "freqtrade",
    "storeSlug": "ci-apps",
    "name": "Freqtrade",
    "expectedPort": 18899,
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
    "id": "freshrss",
    "storeSlug": "ci-apps",
    "name": "FreshRSS",
    "expectedPort": 18974,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "books"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "friendica",
    "storeSlug": "ci-apps",
    "name": "Friendica",
    "expectedPort": 53338,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 4', () => {
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
