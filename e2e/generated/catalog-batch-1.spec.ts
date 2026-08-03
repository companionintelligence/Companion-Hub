
/**
 * Auto-generated app catalog tests for server batch 1
 * Generated: 2026-08-03T06:03:25.005Z
 * Apps: 50
 */

import { expect, loginUser, test } from '../fixtures/fixtures';

const APPS = [
  {
    "id": "fastgpt",
    "storeSlug": "ci-apps",
    "name": "FastGPT",
    "expectedPort": 18918,
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
    "id": "firecrawl",
    "storeSlug": "ci-apps",
    "name": "Firecrawl",
    "expectedPort": 18926,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "ai"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "foldergram",
    "storeSlug": "ci-apps",
    "name": "Foldergram",
    "expectedPort": 8731,
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
    "id": "forgejo",
    "storeSlug": "ci-apps",
    "name": "Forgejo",
    "expectedPort": 8101,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "fossflow",
    "storeSlug": "ci-apps",
    "name": "FossFLOW",
    "expectedPort": 8732,
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
    "id": "freecut",
    "storeSlug": "ci-apps",
    "name": "FreeCut",
    "expectedPort": 8400,
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
    "id": "funclip",
    "storeSlug": "ci-apps",
    "name": "FunClip",
    "expectedPort": 18895,
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
    "id": "geth",
    "storeSlug": "ci-apps",
    "name": "Ethereum",
    "expectedPort": 8545,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "finance",
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "git-mcp",
    "storeSlug": "ci-apps",
    "name": "Git MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "development"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "gitea",
    "storeSlug": "ci-apps",
    "name": "Gitea",
    "expectedPort": 8283,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "featured"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "gitea-mirror",
    "storeSlug": "ci-apps",
    "name": "Gitea Mirror",
    "expectedPort": 8734,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "github-mcp",
    "storeSlug": "ci-apps",
    "name": "GitHub MCP",
    "expectedPort": 80,
    "healthEndpoint": "/",
    "hasGui": false,
    "categories": [
      "mcp",
      "development"
    ],
    "priority": "medium",
    "mcp": true,
    "mcpTransport": "stdio"
  },
  {
    "id": "gitingest",
    "storeSlug": "ci-apps",
    "name": "Gitingest",
    "expectedPort": 8735,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "ai"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "gitlab",
    "storeSlug": "ci-apps",
    "name": "GitLab CE",
    "expectedPort": 8929,
    "healthEndpoint": "/users/sign_in",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "gyroflow",
    "storeSlug": "ci-apps",
    "name": "Gyroflow",
    "expectedPort": 8401,
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
    "id": "halo",
    "storeSlug": "ci-apps",
    "name": "Halo",
    "expectedPort": 18959,
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
    "id": "hasura",
    "storeSlug": "ci-apps",
    "name": "Hasura",
    "expectedPort": 18950,
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
    "id": "hunyuan3d",
    "storeSlug": "ci-apps",
    "name": "Hunyuan3D",
    "expectedPort": 18821,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "hunyuan3d-rocm",
    "storeSlug": "ci-apps",
    "name": "Hunyuan3D ROCm",
    "expectedPort": 18815,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "influxdb",
    "storeSlug": "ci-apps",
    "name": "InfluxDB",
    "expectedPort": 8743,
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
    "id": "influxdb2",
    "storeSlug": "ci-apps",
    "name": "InfluxDB 2",
    "expectedPort": 8744,
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
    "id": "inkscape",
    "storeSlug": "ci-apps",
    "name": "Inkscape",
    "expectedPort": 18824,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "invidious",
    "storeSlug": "ci-apps",
    "name": "Invidious",
    "expectedPort": 8745,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "social",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "ipfs",
    "storeSlug": "ci-apps",
    "name": "IPFS",
    "expectedPort": 18930,
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
    "id": "it-tools",
    "storeSlug": "ci-apps",
    "name": "IT-Tools",
    "expectedPort": 18848,
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
    "id": "jaeger",
    "storeSlug": "ci-apps",
    "name": "Jaeger",
    "expectedPort": 16686,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "jellyseerr",
    "storeSlug": "ci-apps",
    "name": "Seerr",
    "expectedPort": 8749,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "jsonhero",
    "storeSlug": "ci-apps",
    "name": "JSON Hero",
    "expectedPort": 18962,
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
    "id": "jupyter-notebook",
    "storeSlug": "ci-apps",
    "name": "Jupyter Notebook",
    "expectedPort": 8888,
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
    "id": "jupyterhub",
    "storeSlug": "ci-apps",
    "name": "JupyterHub",
    "expectedPort": 18941,
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
    "id": "jupyterlab",
    "storeSlug": "ci-apps",
    "name": "JupyterLab",
    "expectedPort": 8751,
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
    "id": "kan",
    "storeSlug": "ci-apps",
    "name": "kan",
    "expectedPort": 8752,
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
    "id": "kokoro",
    "storeSlug": "ci-apps",
    "name": "Kokoro",
    "expectedPort": 8756,
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
    "id": "komga",
    "storeSlug": "ci-apps",
    "name": "Komga",
    "expectedPort": 25600,
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
    "id": "koodo-reader",
    "storeSlug": "ci-apps",
    "name": "Koodo Reader",
    "expectedPort": 18851,
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
    "id": "langbot",
    "storeSlug": "ci-apps",
    "name": "LangBot",
    "expectedPort": 5300,
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
    "id": "langfuse",
    "storeSlug": "ci-apps",
    "name": "Langfuse",
    "expectedPort": 18920,
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
    "id": "librephotos",
    "storeSlug": "ci-apps",
    "name": "LibrePhotos",
    "expectedPort": 8760,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "photography",
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "litellm",
    "storeSlug": "ci-apps",
    "name": "LiteLLM",
    "expectedPort": 4000,
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
    "id": "llamafactory",
    "storeSlug": "ci-apps",
    "name": "LLaMA Factory",
    "expectedPort": 18935,
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
    "id": "llmfit",
    "storeSlug": "ci-apps",
    "name": "LLMFit",
    "expectedPort": 18963,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "development",
      "ai"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "localai",
    "storeSlug": "ci-apps",
    "name": "LocalAI",
    "expectedPort": 18991,
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
    "id": "louter",
    "storeSlug": "ci-apps",
    "name": "Louter",
    "expectedPort": 6188,
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
    "id": "maxkb",
    "storeSlug": "ci-apps",
    "name": "MaxKB",
    "expectedPort": 18952,
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
    "id": "mazanoke",
    "storeSlug": "ci-apps",
    "name": "Mazanoke",
    "expectedPort": 8768,
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
    "id": "md",
    "storeSlug": "ci-apps",
    "name": "WeChat Markdown Editor",
    "expectedPort": 18911,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "medusa",
    "storeSlug": "ci-apps",
    "name": "Medusa",
    "expectedPort": 18900,
    "healthEndpoint": "/app",
    "hasGui": true,
    "categories": [
      "development"
    ],
    "priority": "medium",
    "mcp": false
  },
  {
    "id": "mermaid-live",
    "storeSlug": "ci-apps",
    "name": "Mermaid Live",
    "expectedPort": 18854,
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
    "id": "metube",
    "storeSlug": "ci-apps",
    "name": "MeTube",
    "expectedPort": 18957,
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
    "id": "miniflux",
    "storeSlug": "ci-apps",
    "name": "Miniflux",
    "expectedPort": 18954,
    "healthEndpoint": "/",
    "hasGui": true,
    "categories": [
      "media",
      "featured"
    ],
    "priority": "medium",
    "mcp": false
  }
];

test.describe('App Catalog Batch 1', () => {
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
