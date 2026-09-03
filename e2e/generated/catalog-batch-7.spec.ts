
/**
 * Auto-generated app catalog tests for server batch 7
 * Generated: 2026-08-19T00:34:24.590Z
 * Apps: 75
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "obsidian",
    "storeSlug": "ci-apps",
    "name": "Obsidian",
    "expectedPort": 8777,
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
    "id": "obsidian-livesync",
    "storeSlug": "ci-apps",
    "name": "Obsidian LiveSync",
    "expectedPort": 5984,
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
    "id": "obsidian-mcp",
    "storeSlug": "ci-apps",
    "name": "Obsidian MCP",
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
    "id": "ocular",
    "storeSlug": "ci-apps",
    "name": "Ocular",
    "expectedPort": 53396,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "odoo",
    "storeSlug": "ci-apps",
    "name": "Odoo",
    "expectedPort": 8069,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "odysseus",
    "storeSlug": "ci-apps",
    "name": "Odysseus",
    "expectedPort": 7000,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "utilities",
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "olmocr",
    "storeSlug": "ci-apps",
    "name": "olmOCR",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "omegaclaw",
    "storeSlug": "ci-apps",
    "name": "OmegaClaw",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "omnitools",
    "storeSlug": "ci-apps",
    "name": "OmniTools",
    "expectedPort": 8779,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "one-time-secret",
    "storeSlug": "ci-apps",
    "name": "Onetime Secret",
    "expectedPort": 53318,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "onlyoffice",
    "storeSlug": "ci-apps",
    "name": "ONLYOFFICE Desktop Editors",
    "expectedPort": 6829,
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
    "id": "onlyoffice-docspace-mcp",
    "storeSlug": "ci-apps",
    "name": "ONLYOFFICE DocSpace MCP",
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
    "id": "onlyoffice-documentserver",
    "storeSlug": "ci-apps",
    "name": "ONLYOFFICE Document Server",
    "expectedPort": 18913,
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
    "id": "open-notebook",
    "storeSlug": "ci-apps",
    "name": "Open Notebook",
    "expectedPort": 8250,
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
    "id": "open-trashmail",
    "storeSlug": "ci-apps",
    "name": "Open Trashmail",
    "expectedPort": 53319,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "openbudgeteer",
    "storeSlug": "ci-apps",
    "name": "OpenBudgeteer",
    "expectedPort": 53362,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "openclaw",
    "storeSlug": "ci-apps",
    "name": "OpenClaw",
    "expectedPort": 30189,
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
    "id": "openemr",
    "storeSlug": "ci-apps",
    "name": "OpenEMR",
    "expectedPort": 53103,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "openfire",
    "storeSlug": "ci-apps",
    "name": "Openfire",
    "expectedPort": 53301,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "openproject",
    "storeSlug": "ci-apps",
    "name": "OpenProject",
    "expectedPort": 18955,
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
    "id": "openremote",
    "storeSlug": "ci-apps",
    "name": "OpenRemote",
    "expectedPort": 53283,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "automation"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "openrouteservice",
    "storeSlug": "ci-apps",
    "name": "OpenRouteService",
    "expectedPort": 53275,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "outline",
    "storeSlug": "ci-apps",
    "name": "Outline",
    "expectedPort": 18862,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "overleaf",
    "storeSlug": "ci-apps",
    "name": "Overleaf",
    "expectedPort": 53060,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "owncloud",
    "storeSlug": "ci-apps",
    "name": "ownCloud",
    "expectedPort": 8780,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ownfoil",
    "storeSlug": "ci-apps",
    "name": "Ownfoil",
    "expectedPort": 53321,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "paaster",
    "storeSlug": "ci-apps",
    "name": "Paaster",
    "expectedPort": 53393,
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
    "id": "paddle-ocr",
    "storeSlug": "ci-apps",
    "name": "PaddleOCR",
    "expectedPort": 18965,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pairdrop",
    "storeSlug": "ci-apps",
    "name": "PairDrop",
    "expectedPort": 8321,
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
    "id": "paperclip",
    "storeSlug": "ci-apps",
    "name": "Paperclip",
    "expectedPort": 3100,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "agents",
      "ai",
      "automation",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "papercups",
    "storeSlug": "ci-apps",
    "name": "Papercups",
    "expectedPort": 18928,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "paperless",
    "storeSlug": "ci-apps",
    "name": "Paperless-ngx",
    "expectedPort": 18972,
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
    "id": "papra",
    "storeSlug": "ci-apps",
    "name": "Papra",
    "expectedPort": 8782,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "part-db",
    "storeSlug": "ci-apps",
    "name": "Part-DB",
    "expectedPort": 53335,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "passbolt",
    "storeSlug": "ci-apps",
    "name": "Passbolt",
    "expectedPort": 8085,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "passky-client",
    "storeSlug": "ci-apps",
    "name": "Passky Client",
    "expectedPort": 8783,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "passky-server",
    "storeSlug": "ci-apps",
    "name": "Passky Server",
    "expectedPort": 8784,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "password-pusher",
    "storeSlug": "ci-apps",
    "name": "Password Pusher",
    "expectedPort": 53295,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "security"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pdfding",
    "storeSlug": "ci-apps",
    "name": "PdfDing",
    "expectedPort": 53282,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pdfmathtranslate",
    "storeSlug": "ci-apps",
    "name": "PDFMathTranslate",
    "expectedPort": 18936,
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
    "id": "pds",
    "storeSlug": "ci-apps",
    "name": "Bluesky PDS",
    "expectedPort": 18923,
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
    "id": "photoprism",
    "storeSlug": "ci-apps",
    "name": "PhotoPrism",
    "expectedPort": 8087,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "phplist",
    "storeSlug": "ci-apps",
    "name": "phpList",
    "expectedPort": 53366,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pi-hole",
    "storeSlug": "ci-apps",
    "name": "Pi-hole",
    "expectedPort": 8082,
    "healthEndpoint": "/admin",
    "hasGui": true,
    "categories": [
      "network",
      "featured"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "picoclaw",
    "storeSlug": "ci-apps",
    "name": "PicoClaw",
    "expectedPort": 8786,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "mcp"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "picoshare",
    "storeSlug": "ci-apps",
    "name": "PicoShare",
    "expectedPort": 53305,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "picsur",
    "storeSlug": "ci-apps",
    "name": "Picsur",
    "expectedPort": 8788,
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
    "id": "pictshare",
    "storeSlug": "ci-apps",
    "name": "PictShare",
    "expectedPort": 53323,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "piefed",
    "storeSlug": "ci-apps",
    "name": "PieFed",
    "expectedPort": 18977,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pingvin-share",
    "storeSlug": "ci-apps",
    "name": "Pingvin Share",
    "expectedPort": 8790,
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
    "id": "plane",
    "storeSlug": "ci-apps",
    "name": "Plane",
    "expectedPort": 18822,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "planka",
    "storeSlug": "ci-apps",
    "name": "Planka",
    "expectedPort": 8791,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "plik",
    "storeSlug": "ci-apps",
    "name": "Plik",
    "expectedPort": 53286,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "plugnmeet",
    "storeSlug": "ci-apps",
    "name": "plugNmeet",
    "expectedPort": 18827,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pluton",
    "storeSlug": "ci-apps",
    "name": "Pluton",
    "expectedPort": 53389,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pogolo",
    "storeSlug": "ci-apps",
    "name": "Pogolo",
    "expectedPort": 5661,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "finance",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "postgres-mcp",
    "storeSlug": "ci-apps",
    "name": "Postgres MCP",
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
    "id": "postiz",
    "storeSlug": "ci-apps",
    "name": "Postiz",
    "expectedPort": 4007,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "poznote",
    "storeSlug": "ci-apps",
    "name": "Poznote",
    "expectedPort": 8792,
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
    "id": "prestashop",
    "storeSlug": "ci-apps",
    "name": "PrestaShop",
    "expectedPort": 8923,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "privatebin",
    "storeSlug": "ci-apps",
    "name": "PrivateBin",
    "expectedPort": 8793,
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
    "id": "project-nomad",
    "storeSlug": "ci-apps",
    "name": "Project N.O.M.A.D.",
    "expectedPort": 8233,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "books",
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "prometheus",
    "storeSlug": "ci-apps",
    "name": "Prometheus",
    "expectedPort": 9090,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "proxmox-backup",
    "storeSlug": "ci-apps",
    "name": "Proxmox Backup Server",
    "expectedPort": 8007,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "proxmox-mail",
    "storeSlug": "ci-apps",
    "name": "Proxmox Mail Gateway",
    "expectedPort": 18971,
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
    "id": "psitransfer",
    "storeSlug": "ci-apps",
    "name": "PsiTransfer",
    "expectedPort": 53276,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "pterodactyl",
    "storeSlug": "ci-apps",
    "name": "Pterodactyl",
    "expectedPort": 53130,
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
    "id": "public-pool",
    "storeSlug": "ci-apps",
    "name": "Public Pool",
    "expectedPort": 8217,
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
    "id": "pyload-ng",
    "storeSlug": "ci-apps",
    "name": "pyLoad-ng",
    "expectedPort": 8794,
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
    "id": "qbittorrent",
    "storeSlug": "ci-apps",
    "name": "qBittorrent",
    "expectedPort": 8327,
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
    "id": "quant-ux",
    "storeSlug": "ci-apps",
    "name": "Quant-UX",
    "expectedPort": 53204,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "quickshare",
    "storeSlug": "ci-apps",
    "name": "Quickshare",
    "expectedPort": 53412,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "quickwit",
    "storeSlug": "ci-apps",
    "name": "Quickwit",
    "expectedPort": 53084,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "data"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "radicale",
    "storeSlug": "ci-apps",
    "name": "Radicale",
    "expectedPort": 5232,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "utilities"
    ],
    "priority": "low",
    "mcp": false
  },
  {
    "id": "ragflow",
    "storeSlug": "ci-apps",
    "name": "RAGFlow",
    "expectedPort": 18886,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "ai",
      "data"
    ],
    "priority": "low",
    "mcp": false
  }
];

test.describe('App Catalog Batch 7', () => {
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
