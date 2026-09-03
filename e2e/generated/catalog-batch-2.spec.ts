
/**
 * Auto-generated app catalog tests for server batch 2
 * Generated: 2026-08-19T00:34:24.588Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "ovenmediaengine",
    "storeSlug": "ci-apps",
    "name": "OvenMediaEngine",
    "expectedPort": 53272,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "owncast",
    "storeSlug": "ci-apps",
    "name": "Owncast",
    "expectedPort": 18956,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "social"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "pastefy",
    "storeSlug": "ci-apps",
    "name": "Pastefy",
    "expectedPort": 8785,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "peertube",
    "storeSlug": "ci-apps",
    "name": "PeerTube",
    "expectedPort": 53072,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "penpot",
    "storeSlug": "ci-apps",
    "name": "Penpot",
    "expectedPort": 18908,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "photofield",
    "storeSlug": "ci-apps",
    "name": "Photofield",
    "expectedPort": 53385,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "photography"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "photoview",
    "storeSlug": "ci-apps",
    "name": "Photoview",
    "expectedPort": 18914,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "photography",
      "media",
      "featured"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "pinchflat",
    "storeSlug": "ci-apps",
    "name": "Pinchflat",
    "expectedPort": 8789,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "automation"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "pinepods",
    "storeSlug": "ci-apps",
    "name": "PinePods",
    "expectedPort": 53324,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "plausible",
    "storeSlug": "ci-apps",
    "name": "Plausible Analytics",
    "expectedPort": 18973,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "playwright-mcp",
    "storeSlug": "ci-apps",
    "name": "Playwright MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "network",
      "development"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "pocketbase",
    "storeSlug": "ci-apps",
    "name": "PocketBase",
    "expectedPort": 5400,
    "healthEndpoint": "/_/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "prowlarr",
    "storeSlug": "ci-apps",
    "name": "Prowlarr",
    "expectedPort": 9696,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "qinglong",
    "storeSlug": "ci-apps",
    "name": "Qinglong",
    "expectedPort": 5700,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "quarkdown",
    "storeSlug": "ci-apps",
    "name": "Quarkdown",
    "expectedPort": 8328,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "rabbitmq",
    "storeSlug": "ci-apps",
    "name": "RabbitMQ",
    "expectedPort": 18968,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "data"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "radarr",
    "storeSlug": "ci-apps",
    "name": "Radarr",
    "expectedPort": 7878,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "readarr",
    "storeSlug": "ci-apps",
    "name": "Readarr",
    "expectedPort": 18964,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "books",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "reaparr",
    "storeSlug": "ci-apps",
    "name": "Reaparr",
    "expectedPort": 53422,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "remotion-studio",
    "storeSlug": "ci-apps",
    "name": "Remotion Studio",
    "expectedPort": 18869,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "restreamer",
    "storeSlug": "ci-apps",
    "name": "Restreamer",
    "expectedPort": 53108,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "retrom",
    "storeSlug": "ci-apps",
    "name": "Retrom",
    "expectedPort": 53221,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "gaming",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "romm",
    "storeSlug": "ci-apps",
    "name": "RomM",
    "expectedPort": 8797,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "gaming",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "ryot",
    "storeSlug": "ci-apps",
    "name": "Ryot",
    "expectedPort": 53262,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sdwebui",
    "storeSlug": "ci-apps",
    "name": "Stable Diffusion WebUI",
    "expectedPort": 18896,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sdwebui-forge-neo",
    "storeSlug": "ci-apps",
    "name": "SD WebUI Forge Neo",
    "expectedPort": 17860,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sdwebuiforge",
    "storeSlug": "ci-apps",
    "name": "Stable Diffusion WebUI Forge",
    "expectedPort": 18937,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "seatable",
    "storeSlug": "ci-apps",
    "name": "SeaTable",
    "expectedPort": 18887,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "showdoc",
    "storeSlug": "ci-apps",
    "name": "ShowDoc",
    "expectedPort": 18916,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sickchill",
    "storeSlug": "ci-apps",
    "name": "SickChill",
    "expectedPort": 18958,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "slink",
    "storeSlug": "ci-apps",
    "name": "Slink",
    "expectedPort": 8200,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "photography",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "snapify",
    "storeSlug": "ci-apps",
    "name": "Snapify",
    "expectedPort": 8253,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sonarr",
    "storeSlug": "ci-apps",
    "name": "Sonarr",
    "expectedPort": 18904,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "automation"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "sqlitebrowser",
    "storeSlug": "ci-apps",
    "name": "SQLite Browser",
    "expectedPort": 8804,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "srs",
    "storeSlug": "ci-apps",
    "name": "SRS",
    "expectedPort": 53031,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "steam-headless",
    "storeSlug": "ci-apps",
    "name": "Steam Headless",
    "expectedPort": 8184,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "featured"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "strix",
    "storeSlug": "ci-apps",
    "name": "Strix",
    "expectedPort": 4567,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network",
      "utilities",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "svix",
    "storeSlug": "ci-apps",
    "name": "Svix",
    "expectedPort": 53266,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "swingmusic",
    "storeSlug": "ci-apps",
    "name": "Swing Music",
    "expectedPort": 8808,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "music",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tabby",
    "storeSlug": "ci-apps",
    "name": "Tabby",
    "expectedPort": 53024,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "taiga",
    "storeSlug": "ci-apps",
    "name": "Taiga",
    "expectedPort": 8290,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tautulli",
    "storeSlug": "ci-apps",
    "name": "Tautulli",
    "expectedPort": 8181,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tensorzero",
    "storeSlug": "ci-apps",
    "name": "TensorZero",
    "expectedPort": 18929,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "termix",
    "storeSlug": "ci-apps",
    "name": "Termix",
    "expectedPort": 8812,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "network"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tldraw",
    "storeSlug": "ci-apps",
    "name": "tldraw",
    "expectedPort": 8322,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tooljet",
    "storeSlug": "ci-apps",
    "name": "ToolJet",
    "expectedPort": 18875,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "data"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "trailbase",
    "storeSlug": "ci-apps",
    "name": "TrailBase",
    "expectedPort": 53099,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "tubearchivist",
    "storeSlug": "ci-apps",
    "name": "Tube Archivist",
    "expectedPort": 8819,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "umami",
    "storeSlug": "ci-apps",
    "name": "Umami",
    "expectedPort": 25727,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "unity-mcp-ivanmurzak",
    "storeSlug": "ci-apps",
    "name": "Unity MCP (Ivan Murzak)",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "unreal-engine-mcp",
    "storeSlug": "ci-apps",
    "name": "Unreal Engine MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "vert",
    "storeSlug": "ci-apps",
    "name": "VERT",
    "expectedPort": 8821,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "vikunja",
    "storeSlug": "ci-apps",
    "name": "Vikunja",
    "expectedPort": 18976,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "vui",
    "storeSlug": "ci-apps",
    "name": "VUI",
    "expectedPort": 9013,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "weblate",
    "storeSlug": "ci-apps",
    "name": "Weblate",
    "expectedPort": 53177,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "webtor",
    "storeSlug": "ci-apps",
    "name": "Webtor",
    "expectedPort": 53406,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "wikijs",
    "storeSlug": "ci-apps",
    "name": "WikiJS",
    "expectedPort": 8826,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "wizarr",
    "storeSlug": "ci-apps",
    "name": "Wizarr",
    "expectedPort": 5690,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "woodpecker-ci",
    "storeSlug": "ci-apps",
    "name": "Woodpecker CI",
    "expectedPort": 18817,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "workbench",
    "storeSlug": "ci-apps",
    "name": "Workbench",
    "expectedPort": 53428,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "xandikos",
    "storeSlug": "ci-apps",
    "name": "Xandikos",
    "expectedPort": 53386,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "xinference",
    "storeSlug": "ci-apps",
    "name": "Xinference",
    "expectedPort": 9997,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "yamtrack",
    "storeSlug": "ci-apps",
    "name": "Yamtrack",
    "expectedPort": 8828,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "youtube-transcript-mcp",
    "storeSlug": "ci-apps",
    "name": "YouTube Transcript MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "media"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "yt-navigator",
    "storeSlug": "ci-apps",
    "name": "YT Navigator",
    "expectedPort": 18945,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "zot",
    "storeSlug": "ci-apps",
    "name": "Zot",
    "expectedPort": 53207,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "utilities"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "4ga-boards",
    "storeSlug": "ci-apps",
    "name": "4ga Boards",
    "expectedPort": 53405,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ace-step",
    "storeSlug": "ci-apps",
    "name": "ACE-Step 1.5",
    "expectedPort": 7860,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "music",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "activepieces",
    "storeSlug": "ci-apps",
    "name": "Activepieces",
    "expectedPort": 8146,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "actual",
    "storeSlug": "ci-apps",
    "name": "Actual Budget",
    "expectedPort": 53036,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "adguardhome",
    "storeSlug": "ci-apps",
    "name": "AdGuard Home",
    "expectedPort": 18909,
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
    "id": "adguardhome-sync",
    "storeSlug": "ci-apps",
    "name": "Adguard Home Sync",
    "expectedPort": 8436,
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
    "id": "adminer",
    "storeSlug": "ci-apps",
    "name": "Adminer",
    "expectedPort": 53145,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "adventurelog",
    "storeSlug": "ci-apps",
    "name": "AdventureLog",
    "expectedPort": 8015,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "affine",
    "storeSlug": "ci-apps",
    "name": "Affine",
    "expectedPort": 3013,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 2', () => {
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
