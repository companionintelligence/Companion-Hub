
/**
 * Auto-generated app catalog tests for server batch 5
 * Generated: 2026-08-19T00:34:24.589Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "frigate",
    "storeSlug": "ci-apps",
    "name": "Frigate",
    "expectedPort": 5004,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "gaianet",
    "storeSlug": "ci-apps",
    "name": "GaiaNet",
    "expectedPort": 18949,
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
    "id": "galette",
    "storeSlug": "ci-apps",
    "name": "Galette",
    "expectedPort": 8081,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "gameyfin",
    "storeSlug": "ci-apps",
    "name": "Gameyfin",
    "expectedPort": 53351,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ganymede",
    "storeSlug": "ci-apps",
    "name": "Ganymede",
    "expectedPort": 53357,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "gatus",
    "storeSlug": "ci-apps",
    "name": "Gatus",
    "expectedPort": 53078,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ghost",
    "storeSlug": "ci-apps",
    "name": "Ghost",
    "expectedPort": 3368,
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
    "id": "ghostfolio",
    "storeSlug": "ci-apps",
    "name": "Ghostfolio",
    "expectedPort": 8246,
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
    "id": "glasshome",
    "storeSlug": "ci-apps",
    "name": "GlassHome",
    "expectedPort": 8736,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "globaleaks",
    "storeSlug": "ci-apps",
    "name": "GlobaLeaks",
    "expectedPort": 53231,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "go-feature-flag",
    "storeSlug": "ci-apps",
    "name": "GO Feature Flag",
    "expectedPort": 53216,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "grafana",
    "storeSlug": "ci-apps",
    "name": "Grafana",
    "expectedPort": 18889,
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
    "id": "graylog",
    "storeSlug": "ci-apps",
    "name": "Graylog",
    "expectedPort": 9000,
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
    "id": "grist",
    "storeSlug": "ci-apps",
    "name": "Grist",
    "expectedPort": 18852,
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
    "id": "grocy",
    "storeSlug": "ci-apps",
    "name": "Grocy",
    "expectedPort": 9283,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "gupt",
    "storeSlug": "ci-apps",
    "name": "Gupt",
    "expectedPort": 8251,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "habitica",
    "storeSlug": "ci-apps",
    "name": "Habitica",
    "expectedPort": 8738,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "gaming",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "handbrake-web",
    "storeSlug": "ci-apps",
    "name": "HandBrake Web",
    "expectedPort": 53374,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hedgedoc",
    "storeSlug": "ci-apps",
    "name": "HedgeDoc",
    "expectedPort": 53154,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "heimdall",
    "storeSlug": "ci-apps",
    "name": "Heimdall",
    "expectedPort": 8739,
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
    "id": "helicone",
    "storeSlug": "ci-apps",
    "name": "Helicone",
    "expectedPort": 53175,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hermes-agent",
    "storeSlug": "ci-apps",
    "name": "Hermes Agent",
    "expectedPort": 9119,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "agents",
      "ai",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hermitstash",
    "storeSlug": "ci-apps",
    "name": "HermitStash",
    "expectedPort": 8237,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security",
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "heyform",
    "storeSlug": "ci-apps",
    "name": "HeyForm",
    "expectedPort": 53136,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hi-events",
    "storeSlug": "ci-apps",
    "name": "Hi.Events",
    "expectedPort": 8300,
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
    "id": "hindsight",
    "storeSlug": "ci-apps",
    "name": "Hindsight",
    "expectedPort": 8834,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hister",
    "storeSlug": "ci-apps",
    "name": "Hister",
    "expectedPort": 53280,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "homebox",
    "storeSlug": "ci-apps",
    "name": "HomeBox",
    "expectedPort": 7745,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "homehub",
    "storeSlug": "ci-apps",
    "name": "HomeHub",
    "expectedPort": 8742,
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
    "id": "homer-infrastructure-monitoring",
    "storeSlug": "ci-apps",
    "name": "Homer",
    "expectedPort": 53223,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hoppscotch",
    "storeSlug": "ci-apps",
    "name": "Hoppscotch",
    "expectedPort": 18820,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "hortusfox",
    "storeSlug": "ci-apps",
    "name": "HortusFox",
    "expectedPort": 8211,
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
    "id": "hyperdx",
    "storeSlug": "ci-apps",
    "name": "HyperDX",
    "expectedPort": 53124,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "i-hate-money",
    "storeSlug": "ci-apps",
    "name": "I Hate Money",
    "expectedPort": 53249,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "imgproxy",
    "storeSlug": "ci-apps",
    "name": "imgproxy",
    "expectedPort": 53095,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "indexttsv2",
    "storeSlug": "ci-apps",
    "name": "IndexTTS2",
    "expectedPort": 18933,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "infisical",
    "storeSlug": "ci-apps",
    "name": "Infisical",
    "expectedPort": 53033,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "invio",
    "storeSlug": "ci-apps",
    "name": "Invio",
    "expectedPort": 8746,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "invoice-ninja",
    "storeSlug": "ci-apps",
    "name": "Invoice Ninja",
    "expectedPort": 8747,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "invoiceplane",
    "storeSlug": "ci-apps",
    "name": "InvoicePlane",
    "expectedPort": 53297,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "invoiceshelf",
    "storeSlug": "ci-apps",
    "name": "InvoiceShelf",
    "expectedPort": 53288,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "itflow",
    "storeSlug": "ci-apps",
    "name": "ITFlow",
    "expectedPort": 53363,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "jackett",
    "storeSlug": "ci-apps",
    "name": "Jackett",
    "expectedPort": 9117,
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
    "id": "jdownloader2",
    "storeSlug": "ci-apps",
    "name": "JDownloader 2",
    "expectedPort": 5800,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "jitsi",
    "storeSlug": "ci-apps",
    "name": "Jitsi Meet",
    "expectedPort": 8443,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "joomla",
    "storeSlug": "ci-apps",
    "name": "Joomla!",
    "expectedPort": 53109,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "joplin",
    "storeSlug": "ci-apps",
    "name": "Joplin Server",
    "expectedPort": 9015,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "jotty",
    "storeSlug": "ci-apps",
    "name": "Jotty",
    "expectedPort": 8750,
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
    "id": "kanboard",
    "storeSlug": "ci-apps",
    "name": "Kanboard",
    "expectedPort": 53125,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kaneo",
    "storeSlug": "ci-apps",
    "name": "Kaneo",
    "expectedPort": 53142,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "karakeep",
    "storeSlug": "ci-apps",
    "name": "Karakeep",
    "expectedPort": 18890,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "keila",
    "storeSlug": "ci-apps",
    "name": "Keila",
    "expectedPort": 18825,
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
    "id": "kener",
    "storeSlug": "ci-apps",
    "name": "Kener",
    "expectedPort": 53110,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kestra",
    "storeSlug": "ci-apps",
    "name": "Kestra",
    "expectedPort": 53038,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "khoj",
    "storeSlug": "ci-apps",
    "name": "Khoj",
    "expectedPort": 53018,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kill-bill",
    "storeSlug": "ci-apps",
    "name": "Kill Bill",
    "expectedPort": 53097,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kimai",
    "storeSlug": "ci-apps",
    "name": "Kimai",
    "expectedPort": 8754,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kitchenowl",
    "storeSlug": "ci-apps",
    "name": "KitchenOwl",
    "expectedPort": 8755,
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
    "id": "kiwix",
    "storeSlug": "ci-apps",
    "name": "Kiwix",
    "expectedPort": 8169,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "books",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "koillection",
    "storeSlug": "ci-apps",
    "name": "Koillection",
    "expectedPort": 53255,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "krayin",
    "storeSlug": "ci-apps",
    "name": "Krayin",
    "expectedPort": 53044,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kutt",
    "storeSlug": "ci-apps",
    "name": "Kutt",
    "expectedPort": 53094,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "kwaainet",
    "storeSlug": "ci-apps",
    "name": "KwaaiNet",
    "expectedPort": 18874,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "ai",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "l-town",
    "storeSlug": "ci-apps",
    "name": "L-Town",
    "expectedPort": 8757,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "gaming",
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "lancache",
    "storeSlug": "ci-apps",
    "name": "LanCache",
    "expectedPort": 53316,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "langflow",
    "storeSlug": "ci-apps",
    "name": "Langflow",
    "expectedPort": 18934,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "leafwiki",
    "storeSlug": "ci-apps",
    "name": "LeafWiki",
    "expectedPort": 8758,
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
    "id": "leantime",
    "storeSlug": "ci-apps",
    "name": "Leantime",
    "expectedPort": 8247,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "learnhouse",
    "storeSlug": "ci-apps",
    "name": "LearnHouse",
    "expectedPort": 53212,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ledgersmb",
    "storeSlug": "ci-apps",
    "name": "LedgerSMB",
    "expectedPort": 53394,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "lego-oracle-mcp",
    "storeSlug": "ci-apps",
    "name": "LEGO Oracle MCP",
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
    "id": "leomoon-wiki-go",
    "storeSlug": "ci-apps",
    "name": "LeoMoon Wiki-Go",
    "expectedPort": 53419,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "librechat",
    "storeSlug": "ci-apps",
    "name": "LibreChat",
    "expectedPort": 3080,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "libreoffice",
    "storeSlug": "ci-apps",
    "name": "LibreOffice",
    "expectedPort": 18872,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "librespeed",
    "storeSlug": "ci-apps",
    "name": "LibreSpeed",
    "expectedPort": 18961,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 5', () => {
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
