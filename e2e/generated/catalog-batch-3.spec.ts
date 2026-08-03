
/**
 * Auto-generated app catalog tests for server batch 3
 * Generated: 2026-08-03T06:03:25.006Z
 * Apps: 50
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
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
  },
  {
    "id": "agent-zero",
    "storeSlug": "ci-apps",
    "name": "Agent Zero",
    "expectedPort": 8700,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "agents",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "agentzero",
    "storeSlug": "ci-apps",
    "name": "Agent Zero",
    "expectedPort": 18780,
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
    "id": "airtrail",
    "storeSlug": "ci-apps",
    "name": "AirTrail",
    "expectedPort": 8230,
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
    "id": "akaunting",
    "storeSlug": "ci-apps",
    "name": "Akaunting",
    "expectedPort": 8701,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "alist",
    "storeSlug": "ci-apps",
    "name": "AList",
    "expectedPort": 5244,
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
    "id": "am-i-exposed",
    "storeSlug": "ci-apps",
    "name": "Am I Exposed?",
    "expectedPort": 8252,
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
    "id": "answer",
    "storeSlug": "ci-apps",
    "name": "Answer",
    "expectedPort": 18883,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "anything-llm",
    "storeSlug": "ci-apps",
    "name": "AnythingLLM",
    "expectedPort": 3001,
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
    "id": "appflowy",
    "storeSlug": "ci-apps",
    "name": "AppFlowy",
    "expectedPort": 9036,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "archivebox",
    "storeSlug": "ci-apps",
    "name": "ArchiveBox",
    "expectedPort": 8428,
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
    "id": "astral",
    "storeSlug": "ci-apps",
    "name": "Astral",
    "expectedPort": 8000,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "autobrr",
    "storeSlug": "ci-apps",
    "name": "autobrr",
    "expectedPort": 18870,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "baikal",
    "storeSlug": "ci-apps",
    "name": "Baikal",
    "expectedPort": 8705,
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
    "id": "baserow",
    "storeSlug": "ci-apps",
    "name": "Baserow",
    "expectedPort": 8317,
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
    "id": "beatsync",
    "storeSlug": "ci-apps",
    "name": "Beatsync",
    "expectedPort": 18969,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "music"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "bentopdf",
    "storeSlug": "ci-apps",
    "name": "BentoPDF",
    "expectedPort": 18879,
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
    "id": "bisq2-node",
    "storeSlug": "ci-apps",
    "name": "Bisq 2 Node",
    "expectedPort": 8832,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "bitboard",
    "storeSlug": "ci-apps",
    "name": "bitBoard",
    "expectedPort": 8311,
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
    "id": "bitcoind",
    "storeSlug": "ci-apps",
    "name": "Bitcoin",
    "expectedPort": 8333,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "blender-mcp",
    "storeSlug": "ci-apps",
    "name": "Blender MCP",
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
    "id": "blinko",
    "storeSlug": "ci-apps",
    "name": "Blinko",
    "expectedPort": 1111,
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
    "id": "bookstack",
    "storeSlug": "ci-apps",
    "name": "BookStack",
    "expectedPort": 8709,
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
    "id": "brewers-almanack-mcp",
    "storeSlug": "ci-apps",
    "name": "Brewers Almanack MCP",
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
    "id": "bytebase",
    "storeSlug": "ci-apps",
    "name": "Bytebase",
    "expectedPort": 8326,
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
    "id": "cal",
    "storeSlug": "ci-apps",
    "name": "Cal.diy",
    "expectedPort": 18907,
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
    "id": "calibre-web",
    "storeSlug": "ci-apps",
    "name": "Calibre-Web",
    "expectedPort": 8083,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "books"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 3', () => {
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
