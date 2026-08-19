
/**
 * Auto-generated app catalog tests for server batch 8
 * Generated: 2026-08-19T00:34:24.590Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "rallly",
    "storeSlug": "ci-apps",
    "name": "Rallly",
    "expectedPort": 18891,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "raneto",
    "storeSlug": "ci-apps",
    "name": "Raneto",
    "expectedPort": 53325,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "razzia",
    "storeSlug": "ci-apps",
    "name": "Razzia",
    "expectedPort": 8254,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "reactive-resume",
    "storeSlug": "ci-apps",
    "name": "Reactive Resume",
    "expectedPort": 53012,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "readeck",
    "storeSlug": "ci-apps",
    "name": "Readeck",
    "expectedPort": 8592,
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
    "id": "readur",
    "storeSlug": "ci-apps",
    "name": "Readur",
    "expectedPort": 8795,
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
    "id": "redash",
    "storeSlug": "ci-apps",
    "name": "Redash",
    "expectedPort": 53032,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "reddit-mcp",
    "storeSlug": "ci-apps",
    "name": "Reddit MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "social"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "reitti",
    "storeSlug": "ci-apps",
    "name": "Reitti",
    "expectedPort": 8232,
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
    "id": "relaticle",
    "storeSlug": "ci-apps",
    "name": "Relaticle",
    "expectedPort": 53233,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "mcp"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "remark42",
    "storeSlug": "ci-apps",
    "name": "Remark42",
    "expectedPort": 53098,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "rembg",
    "storeSlug": "ci-apps",
    "name": "Rembg",
    "expectedPort": 18931,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "photography"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "remmina",
    "storeSlug": "ci-apps",
    "name": "Remmina",
    "expectedPort": 8796,
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
    "id": "rms-mail",
    "storeSlug": "ci-apps",
    "name": "RMS Mail",
    "expectedPort": 8330,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "rna-sequencing",
    "storeSlug": "ci-apps",
    "name": "RNA Sequencing",
    "expectedPort": 18966,
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
    "id": "rocketchat",
    "storeSlug": "ci-apps",
    "name": "Rocket.Chat",
    "expectedPort": 18868,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "rolltop",
    "storeSlug": "ci-apps",
    "name": "Rolltop",
    "expectedPort": 8329,
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
    "id": "rotki",
    "storeSlug": "ci-apps",
    "name": "rotki",
    "expectedPort": 8243,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "data",
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "roundcube-webmail",
    "storeSlug": "ci-apps",
    "name": "Roundcube Webmail",
    "expectedPort": 53155,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "route96",
    "storeSlug": "ci-apps",
    "name": "Route96",
    "expectedPort": 8798,
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
    "id": "rss-bridge",
    "storeSlug": "ci-apps",
    "name": "RSS-Bridge",
    "expectedPort": 53129,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "rsshub",
    "storeSlug": "ci-apps",
    "name": "RSSHub",
    "expectedPort": 1200,
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
    "id": "sabnzbd",
    "storeSlug": "ci-apps",
    "name": "SABnzbd",
    "expectedPort": 8799,
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
    "id": "safeos",
    "storeSlug": "ci-apps",
    "name": "SafeOS Guardian",
    "expectedPort": 18882,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "security",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "saltcorn",
    "storeSlug": "ci-apps",
    "name": "Saltcorn",
    "expectedPort": 53218,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "samba",
    "storeSlug": "ci-apps",
    "name": "Samba",
    "expectedPort": 18867,
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
    "id": "satsbook",
    "storeSlug": "ci-apps",
    "name": "Satsbook",
    "expectedPort": 8240,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "scribble-rs",
    "storeSlug": "ci-apps",
    "name": "Scribble.rs",
    "expectedPort": 53408,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "seafile",
    "storeSlug": "ci-apps",
    "name": "Seafile",
    "expectedPort": 8920,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "searxng",
    "storeSlug": "ci-apps",
    "name": "SearXNG",
    "expectedPort": 8325,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "seaweedfs",
    "storeSlug": "ci-apps",
    "name": "SeaweedFS",
    "expectedPort": 53021,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "secondme",
    "storeSlug": "ci-apps",
    "name": "Second Me",
    "expectedPort": 18924,
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
    "id": "securo",
    "storeSlug": "ci-apps",
    "name": "Securo",
    "expectedPort": 8331,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "semaphore",
    "storeSlug": "ci-apps",
    "name": "Semaphore UI",
    "expectedPort": 53229,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "servas",
    "storeSlug": "ci-apps",
    "name": "Servas",
    "expectedPort": 53369,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "sglang",
    "storeSlug": "ci-apps",
    "name": "SGLang",
    "expectedPort": 30000,
    "healthEndpoint": "/docs",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "shiori",
    "storeSlug": "ci-apps",
    "name": "Shiori",
    "expectedPort": 53079,
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
    "id": "shkeeper",
    "storeSlug": "ci-apps",
    "name": "SHKeeper",
    "expectedPort": 53421,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "shlink",
    "storeSlug": "ci-apps",
    "name": "Shlink",
    "expectedPort": 53107,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "signature-pdf",
    "storeSlug": "ci-apps",
    "name": "Signature PDF",
    "expectedPort": 53370,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "silex",
    "storeSlug": "ci-apps",
    "name": "Silex",
    "expectedPort": 53306,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "sillytavern",
    "storeSlug": "ci-apps",
    "name": "SillyTavern",
    "expectedPort": 18828,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "silverbullet",
    "storeSlug": "ci-apps",
    "name": "SilverBullet",
    "expectedPort": 53184,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "simplex-chat",
    "storeSlug": "ci-apps",
    "name": "SimpleX Chat",
    "expectedPort": 53069,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "skybro",
    "storeSlug": "ci-apps",
    "name": "SkyBro",
    "expectedPort": 8801,
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
    "id": "slash",
    "storeSlug": "ci-apps",
    "name": "Slash",
    "expectedPort": 53274,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "smartest-tv-mcp",
    "storeSlug": "ci-apps",
    "name": "Smartest TV MCP",
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
    "id": "snappymail",
    "storeSlug": "ci-apps",
    "name": "SnappyMail",
    "expectedPort": 53340,
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
    "id": "snort",
    "storeSlug": "ci-apps",
    "name": "Snort",
    "expectedPort": 52027,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "snowflake",
    "storeSlug": "ci-apps",
    "name": "Tor Snowflake Proxy",
    "expectedPort": 8802,
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
    "id": "solidinvoice",
    "storeSlug": "ci-apps",
    "name": "SolidInvoice",
    "expectedPort": 53327,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "solidtime",
    "storeSlug": "ci-apps",
    "name": "Solidtime",
    "expectedPort": 8050,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "spacebot",
    "storeSlug": "ci-apps",
    "name": "Spacebot",
    "expectedPort": 8803,
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
    "id": "speaches",
    "storeSlug": "ci-apps",
    "name": "Speaches",
    "expectedPort": 18898,
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
    "id": "spliit",
    "storeSlug": "ci-apps",
    "name": "Spliit",
    "expectedPort": 18855,
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
    "id": "splitpro",
    "storeSlug": "ci-apps",
    "name": "SplitPro",
    "expectedPort": 53248,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "spoolman",
    "storeSlug": "ci-apps",
    "name": "Spoolman",
    "expectedPort": 53202,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "spree-commerce",
    "storeSlug": "ci-apps",
    "name": "Spree Commerce",
    "expectedPort": 53068,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "sqlite-mcp",
    "storeSlug": "ci-apps",
    "name": "SQLite MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "data"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "stalwart-mail",
    "storeSlug": "ci-apps",
    "name": "Stalwart Mail",
    "expectedPort": 8677,
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
    "id": "standard-notes",
    "storeSlug": "ci-apps",
    "name": "Standard Notes",
    "expectedPort": 9032,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "starbase-80",
    "storeSlug": "ci-apps",
    "name": "Starbase 80",
    "expectedPort": 53395,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
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
    "id": "storyden",
    "storeSlug": "ci-apps",
    "name": "Storyden",
    "expectedPort": 53433,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
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
    "id": "sup3rs3cretmes5age",
    "storeSlug": "ci-apps",
    "name": "sup3rS3cretMes5age",
    "expectedPort": 53392,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
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
    "id": "superdesk",
    "storeSlug": "ci-apps",
    "name": "Superdesk",
    "expectedPort": 53380,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "supertokens",
    "storeSlug": "ci-apps",
    "name": "SuperTokens",
    "expectedPort": 53087,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "security"
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
    "id": "swirl-search",
    "storeSlug": "ci-apps",
    "name": "Swirl Search",
    "expectedPort": 53303,
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
  }
];

test.describe('App Catalog Batch 8', () => {
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
