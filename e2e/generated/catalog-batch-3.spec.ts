
/**
 * Auto-generated app catalog tests for server batch 3
 * Generated: 2026-08-19T00:34:24.588Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
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
    "id": "aitable",
    "storeSlug": "ci-apps",
    "name": "AITable",
    "expectedPort": 53089,
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
    "id": "alf-io",
    "storeSlug": "ci-apps",
    "name": "Alf.io",
    "expectedPort": 53347,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "apache-solr",
    "storeSlug": "ci-apps",
    "name": "Apache Solr",
    "expectedPort": 53341,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
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
    "id": "atomic-server",
    "storeSlug": "ci-apps",
    "name": "Atomic Server",
    "expectedPort": 53228,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "bagisto",
    "storeSlug": "ci-apps",
    "name": "Bagisto",
    "expectedPort": 53037,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "beaver-habit-tracker",
    "storeSlug": "ci-apps",
    "name": "Beaver Habit Tracker",
    "expectedPort": 53284,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "bencher",
    "storeSlug": "ci-apps",
    "name": "Bencher",
    "expectedPort": 53329,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "bichon",
    "storeSlug": "ci-apps",
    "name": "Bichon",
    "expectedPort": 53279,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "bitwarden",
    "storeSlug": "ci-apps",
    "name": "Bitwarden",
    "expectedPort": 53057,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "security"
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
    "id": "bludit",
    "storeSlug": "ci-apps",
    "name": "Bludit",
    "expectedPort": 53240,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
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
    "id": "bracket",
    "storeSlug": "ci-apps",
    "name": "Bracket",
    "expectedPort": 53336,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
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
    "id": "budget-board",
    "storeSlug": "ci-apps",
    "name": "Budget Board",
    "expectedPort": 53331,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
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
    "id": "bytechef",
    "storeSlug": "ci-apps",
    "name": "ByteChef",
    "expectedPort": 53307,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
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
  },
  {
    "id": "campfire",
    "storeSlug": "ci-apps",
    "name": "Campfire",
    "expectedPort": 8712,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "centrifugo",
    "storeSlug": "ci-apps",
    "name": "Centrifugo",
    "expectedPort": 53113,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "changedetection",
    "storeSlug": "ci-apps",
    "name": "changedetection.io",
    "expectedPort": 8210,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "automation",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chatwoot",
    "storeSlug": "ci-apps",
    "name": "Chatwoot",
    "expectedPort": 18830,
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
    "id": "checkmate",
    "storeSlug": "ci-apps",
    "name": "Checkmate",
    "expectedPort": 53115,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chess-mcp",
    "storeSlug": "ci-apps",
    "name": "MCP Chess",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "chevereto",
    "storeSlug": "ci-apps",
    "name": "Chevereto",
    "expectedPort": 53364,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "photography",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chhoto-url",
    "storeSlug": "ci-apps",
    "name": "Chhoto URL",
    "expectedPort": 53308,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chiefonboarding",
    "storeSlug": "ci-apps",
    "name": "ChiefOnboarding",
    "expectedPort": 53309,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chromium",
    "storeSlug": "ci-apps",
    "name": "Chromium",
    "expectedPort": 18917,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "chrony",
    "storeSlug": "ci-apps",
    "name": "chrony",
    "expectedPort": 18866,
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
    "id": "ci-capture",
    "storeSlug": "ci-apps",
    "name": "Companion Capture",
    "expectedPort": 18804,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-hermes",
    "storeSlug": "ci-apps",
    "name": "Hermes",
    "expectedPort": 18790,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "agents",
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-import-tools",
    "storeSlug": "ci-apps",
    "name": "Import Tools",
    "expectedPort": 18802,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-just-in-case",
    "storeSlug": "ci-apps",
    "name": "Just In Case",
    "expectedPort": 18806,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-local-bench",
    "storeSlug": "ci-apps",
    "name": "Local Bench",
    "expectedPort": 18807,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-memory",
    "storeSlug": "ci-apps",
    "name": "Companion Memory",
    "expectedPort": 8642,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "ai",
      "utilities",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-openclaw",
    "storeSlug": "ci-apps",
    "name": "OpenClaw WebCLI",
    "expectedPort": 18789,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "agents",
      "ai",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-planning",
    "storeSlug": "ci-apps",
    "name": "Companion Planning",
    "expectedPort": 18829,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-spatial-companion-webxr",
    "storeSlug": "ci-apps",
    "name": "Spatial Companion",
    "expectedPort": 8123,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-spellbook",
    "storeSlug": "ci-apps",
    "name": "Spellbook",
    "expectedPort": 18805,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ci-tools-cache-mounts",
    "storeSlug": "ci-apps",
    "name": "Tools Cache Mount",
    "expectedPort": 18808,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "companion-intelligence",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "claper",
    "storeSlug": "ci-apps",
    "name": "Claper",
    "expectedPort": 53377,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "classroomio",
    "storeSlug": "ci-apps",
    "name": "ClassroomIO",
    "expectedPort": 53342,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "cloudbeaver",
    "storeSlug": "ci-apps",
    "name": "CloudBeaver",
    "expectedPort": 53191,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "cloudreve",
    "storeSlug": "ci-apps",
    "name": "Cloudreve",
    "expectedPort": 5212,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "cmproxy",
    "storeSlug": "ci-apps",
    "name": "ChatGPT Web Midjourney Proxy",
    "expectedPort": 3002,
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
    "id": "cncjs",
    "storeSlug": "ci-apps",
    "name": "CNCjs",
    "expectedPort": 53205,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "colanode",
    "storeSlug": "ci-apps",
    "name": "Colanode",
    "expectedPort": 4011,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "collabora-online",
    "storeSlug": "ci-apps",
    "name": "Collabora Online",
    "expectedPort": 9980,
    "healthEndpoint": "/browser/dist/admin/admin.html",
    "hasGui": true,
    "categories": [
      "featured",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "comfyui",
    "storeSlug": "ci-apps",
    "name": "ComfyUI",
    "expectedPort": 8188,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "convertx",
    "storeSlug": "ci-apps",
    "name": "ConvertX",
    "expectedPort": 8714,
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
    "id": "copyparty",
    "storeSlug": "ci-apps",
    "name": "copyparty",
    "expectedPort": 8715,
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
    "id": "coral",
    "storeSlug": "ci-apps",
    "name": "Coral",
    "expectedPort": 53224,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "cryptgeon",
    "storeSlug": "ci-apps",
    "name": "Cryptgeon",
    "expectedPort": 18856,
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
    "id": "cryptpad",
    "storeSlug": "ci-apps",
    "name": "CryptPad",
    "expectedPort": 18831,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "data"
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
