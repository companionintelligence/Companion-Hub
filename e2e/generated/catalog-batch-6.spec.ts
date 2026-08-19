
/**
 * Auto-generated app catalog tests for server batch 6
 * Generated: 2026-08-19T00:34:24.589Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "libretranslate",
    "storeSlug": "ci-apps",
    "name": "LibreTranslate",
    "expectedPort": 8241,
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
    "id": "lidarr",
    "storeSlug": "ci-apps",
    "name": "Lidarr",
    "expectedPort": 8686,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "music",
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "lingva-translate",
    "storeSlug": "ci-apps",
    "name": "Lingva Translate",
    "expectedPort": 8201,
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
    "id": "linkace",
    "storeSlug": "ci-apps",
    "name": "LinkAce",
    "expectedPort": 53268,
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
    "id": "linkstack",
    "storeSlug": "ci-apps",
    "name": "LinkStack",
    "expectedPort": 8761,
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
    "id": "linkwarden",
    "storeSlug": "ci-apps",
    "name": "Linkwarden",
    "expectedPort": 8762,
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
    "id": "listmonk",
    "storeSlug": "ci-apps",
    "name": "Listmonk",
    "expectedPort": 18818,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "littlelink",
    "storeSlug": "ci-apps",
    "name": "LittleLink",
    "expectedPort": 53304,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "llama-cpp",
    "storeSlug": "ci-apps",
    "name": "llama.cpp Server",
    "expectedPort": 18951,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "llm-gateway",
    "storeSlug": "ci-apps",
    "name": "LLM Gateway",
    "expectedPort": 53230,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "lobe-chat",
    "storeSlug": "ci-apps",
    "name": "Lobe Chat",
    "expectedPort": 7455,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "local-deep-research",
    "storeSlug": "ci-apps",
    "name": "Local Deep Research",
    "expectedPort": 53137,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "logseq",
    "storeSlug": "ci-apps",
    "name": "Logseq",
    "expectedPort": 8323,
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
    "id": "loomio",
    "storeSlug": "ci-apps",
    "name": "Loomio",
    "expectedPort": 53208,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "lubelogger",
    "storeSlug": "ci-apps",
    "name": "LubeLogger",
    "expectedPort": 8764,
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
    "id": "lunalytics",
    "storeSlug": "ci-apps",
    "name": "Lunalytics",
    "expectedPort": 18978,
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
    "id": "macos",
    "storeSlug": "ci-apps",
    "name": "macOS",
    "expectedPort": 18826,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mafl",
    "storeSlug": "ci-apps",
    "name": "Mafl",
    "expectedPort": 53379,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mage",
    "storeSlug": "ci-apps",
    "name": "Mage",
    "expectedPort": 53139,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mailarchiver",
    "storeSlug": "ci-apps",
    "name": "Mail Archiver",
    "expectedPort": 8766,
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
    "id": "mailflow",
    "storeSlug": "ci-apps",
    "name": "MailFlow",
    "expectedPort": 8767,
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
    "id": "mailu",
    "storeSlug": "ci-apps",
    "name": "Mailu",
    "expectedPort": 18960,
    "healthEndpoint": "/admin",
    "hasGui": true,
    "categories": [
      "network",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mainsail",
    "storeSlug": "ci-apps",
    "name": "Mainsail",
    "expectedPort": 8242,
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
    "id": "manage-my-damn-life",
    "storeSlug": "ci-apps",
    "name": "Manage My Damn Life",
    "expectedPort": 53415,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "manifest",
    "storeSlug": "ci-apps",
    "name": "Manifest",
    "expectedPort": 53152,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "many-notes",
    "storeSlug": "ci-apps",
    "name": "Many Notes",
    "expectedPort": 53354,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "manyfold",
    "storeSlug": "ci-apps",
    "name": "Manyfold",
    "expectedPort": 53211,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mastodon",
    "storeSlug": "ci-apps",
    "name": "Mastodon",
    "expectedPort": 8274,
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
    "id": "mathesar",
    "storeSlug": "ci-apps",
    "name": "Mathesar",
    "expectedPort": 53111,
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
    "id": "matomo",
    "storeSlug": "ci-apps",
    "name": "Matomo",
    "expectedPort": 8420,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mattermost",
    "storeSlug": "ci-apps",
    "name": "Mattermost",
    "expectedPort": 8265,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mautic",
    "storeSlug": "ci-apps",
    "name": "Mautic",
    "expectedPort": 53119,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mealie",
    "storeSlug": "ci-apps",
    "name": "Mealie",
    "expectedPort": 18967,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "medama-analytics",
    "storeSlug": "ci-apps",
    "name": "Medama Analytics",
    "expectedPort": 53410,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "meme-search",
    "storeSlug": "ci-apps",
    "name": "Meme Search",
    "expectedPort": 53404,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "memos",
    "storeSlug": "ci-apps",
    "name": "Memos",
    "expectedPort": 5230,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mesh-llm",
    "storeSlug": "ci-apps",
    "name": "Mesh LLM",
    "expectedPort": 3131,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "meshcentral",
    "storeSlug": "ci-apps",
    "name": "MeshCentral",
    "expectedPort": 53158,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "metabase",
    "storeSlug": "ci-apps",
    "name": "Metabase",
    "expectedPort": 18921,
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
    "id": "middleware",
    "storeSlug": "ci-apps",
    "name": "Middleware",
    "expectedPort": 53344,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "migpt",
    "storeSlug": "ci-apps",
    "name": "MiGPT",
    "expectedPort": 36592,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "migpttts",
    "storeSlug": "ci-apps",
    "name": "MiGPT-TTS",
    "expectedPort": 18922,
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
    "id": "mindmap",
    "storeSlug": "ci-apps",
    "name": "SimpleMindMap",
    "expectedPort": 18953,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mindustry",
    "storeSlug": "ci-apps",
    "name": "Mindustry Server",
    "expectedPort": 6567,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "gaming",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mixpost",
    "storeSlug": "ci-apps",
    "name": "Mixpost",
    "expectedPort": 18819,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "monetr",
    "storeSlug": "ci-apps",
    "name": "monetr",
    "expectedPort": 8244,
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
    "id": "mongooseim",
    "storeSlug": "ci-apps",
    "name": "MongooseIM",
    "expectedPort": 53293,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "monica",
    "storeSlug": "ci-apps",
    "name": "Monica",
    "expectedPort": 53041,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "morphic",
    "storeSlug": "ci-apps",
    "name": "Morphic",
    "expectedPort": 53133,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "morphos",
    "storeSlug": "ci-apps",
    "name": "Morphos server",
    "expectedPort": 8771,
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
    "id": "motioneye",
    "storeSlug": "ci-apps",
    "name": "motionEye",
    "expectedPort": 53192,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "movary",
    "storeSlug": "ci-apps",
    "name": "Movary",
    "expectedPort": 53378,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "mtranserver",
    "storeSlug": "ci-apps",
    "name": "MTranServer",
    "expectedPort": 18903,
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
    "id": "munin",
    "storeSlug": "ci-apps",
    "name": "Munin",
    "expectedPort": 18864,
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
    "id": "myip",
    "storeSlug": "ci-apps",
    "name": "MyIP",
    "expectedPort": 53081,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "myspeed",
    "storeSlug": "ci-apps",
    "name": "MySpeed",
    "expectedPort": 5216,
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
    "id": "n8n",
    "storeSlug": "ci-apps",
    "name": "n8n",
    "expectedPort": 8579,
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
    "id": "neko",
    "storeSlug": "ci-apps",
    "name": "Neko",
    "expectedPort": 53053,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "netdata",
    "storeSlug": "ci-apps",
    "name": "Netdata",
    "expectedPort": 19999,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nginx-proxy-manager",
    "storeSlug": "ci-apps",
    "name": "Nginx Proxy Manager",
    "expectedPort": 53023,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nocobase",
    "storeSlug": "ci-apps",
    "name": "NocoBase",
    "expectedPort": 18912,
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
    "id": "nocodb",
    "storeSlug": "ci-apps",
    "name": "NocoDB",
    "expectedPort": 9020,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nodebb",
    "storeSlug": "ci-apps",
    "name": "NodeBB",
    "expectedPort": 53074,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nofx",
    "storeSlug": "ci-apps",
    "name": "NOFX",
    "expectedPort": 18885,
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
    "id": "nostr-relay",
    "storeSlug": "ci-apps",
    "name": "Nostr Relay",
    "expectedPort": 4848,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nostream",
    "storeSlug": "ci-apps",
    "name": "Nostream",
    "expectedPort": 8008,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "network"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "nostrudel",
    "storeSlug": "ci-apps",
    "name": "noStrudel",
    "expectedPort": 8775,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "notediscovery",
    "storeSlug": "ci-apps",
    "name": "NoteDiscovery",
    "expectedPort": 9037,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "notesnook",
    "storeSlug": "ci-apps",
    "name": "Notesnook",
    "expectedPort": 8126,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities",
      "security",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "notifo",
    "storeSlug": "ci-apps",
    "name": "Notifo",
    "expectedPort": 53330,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "notifuse",
    "storeSlug": "ci-apps",
    "name": "Notifuse",
    "expectedPort": 53219,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "notion-mcp",
    "storeSlug": "ci-apps",
    "name": "Notion MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "novel",
    "storeSlug": "ci-apps",
    "name": "Novel",
    "expectedPort": 3579,
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
    "id": "ntfy",
    "storeSlug": "ci-apps",
    "name": "ntfy",
    "expectedPort": 18975,
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
    "id": "nzbget",
    "storeSlug": "ci-apps",
    "name": "Nzbget",
    "expectedPort": 6789,
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

test.describe('App Catalog Batch 6', () => {
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
