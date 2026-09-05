import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page, TestInfo } from '@playwright/test';
import { createOnboardingTestUser, expect, test } from '../fixtures/fixtures';
import { testUser } from '../helpers/constants';

type InferenceProvider = 'ollama' | 'dspark' | 'mtplx' | 'vllm' | 'lucebox' | 'lemonade';

interface FixtureRequest {
  provider: InferenceProvider;
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: {
    authorization?: string;
  };
}

interface InferenceFixtureState {
  requests: FixtureRequest[];
}

interface CuratedModelFixture {
  id: string;
  backend: InferenceProvider;
  backendModelId: string;
  modality: string;
  parameterScale?: number;
  requirements: { diskMb: number };
}

interface OnboardingProfileFixture {
  tier: string;
  hardware: {
    cpu: { model: string; arch: string };
    gpu: { vendor: string };
    os: { platform: string };
  };
  recommendedModels: CuratedModelFixture[];
  availableModels: CuratedModelFixture[];
  installedCatalogIds: string[];
  backends: {
    recommended: InferenceProvider;
    available: Array<{ type: InferenceProvider; running: boolean; healthy: boolean }>;
  };
}

interface InferencePreferencesFixture {
  preferredBackend: InferenceProvider | null;
  preferredModel: string | null;
  preferredEmbeddingModel: string | null;
  preferredVllmApiKey?: string | null;
  preferredVllmUrl?: string | null;
  preferredMtplxUrl?: string | null;
  preferredDsparkUrl?: string | null;
}

interface TrackedModelFixture {
  catalogId: string;
  state: string;
}

const execFile = promisify(execFileCallback);
const inferencePort = process.env.FTUE_INFERENCE_FIXTURE_PORT ?? '18090';
const inferenceFixtureUrl = `http://127.0.0.1:${inferencePort}`;
const dockerServiceLabel = 'com.docker.compose.service=ftue-onlyoffice-e2e';
const dockerFixtureUrn = 'ftue-onlyoffice-e2e:ci-marketplace';
const dockerProjectLabel = 'com.docker.compose.project=ftue-onlyoffice-e2e_ci-marketplace';
const terminalModelStates = new Set(['pulled', 'loaded', 'pinned']);

async function resetInferenceFixture(): Promise<void> {
  const response = await fetch(`${inferenceFixtureUrl}/___control/reset`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

async function configureInferenceProvider(provider: InferenceProvider, update: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${inferenceFixtureUrl}/___control/configure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: { [provider]: update } }),
  });
  expect(response.ok).toBe(true);
}

async function inferenceState(): Promise<InferenceFixtureState> {
  const response = await fetch(`${inferenceFixtureUrl}/___control`);
  expect(response.ok).toBe(true);
  return (await response.json()) as InferenceFixtureState;
}

async function recordedRequests(provider: InferenceProvider, path: string): Promise<FixtureRequest[]> {
  const fixture = await inferenceState();
  return fixture.requests.filter((request) => request.provider === provider && request.path === path);
}

async function registerAndOpenFtue(page: Page): Promise<void> {
  await createOnboardingTestUser();
  const loginResponse = await page.request.post('/api/auth/login', {
    data: { username: testUser.email, password: testUser.password },
  });
  if (!loginResponse.ok()) {
    throw new Error(`FTUE test login failed: ${loginResponse.status()} ${await loginResponse.text()}`);
  }
  const login = (await loginResponse.json()) as { sessionId?: string };
  if (!login.sessionId) throw new Error('FTUE test login did not return a session ID');

  await page.goto('/onboarding');
  await page.waitForURL(/\/onboarding(?:[/?#]|$)/, { timeout: 30_000 });
  await page.evaluate((sessionId) => sessionStorage.setItem('ci-hub-session', sessionId), login.sessionId);
  await expect(page.getByRole('heading', { name: 'Set Up Companion Hub' })).toBeVisible();
  await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('recommended-alternatives-chart')).toBeVisible({ timeout: 30_000 });
}

async function fetchProfile(page: Page, backend?: InferenceProvider): Promise<OnboardingProfileFixture> {
  const query = backend ? `?backend=${backend}` : '';
  const response = await page.request.get(`/api/inference/onboarding-profile${query}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as OnboardingProfileFixture;
}

async function fetchPreferences(page: Page): Promise<InferencePreferencesFixture> {
  const response = await page.request.get('/api/inference/preferences');
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as InferencePreferencesFixture;
}

async function fetchTrackedModels(page: Page): Promise<TrackedModelFixture[]> {
  const response = await page.request.get('/api/inference/models/tracked');
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TrackedModelFixture[];
}

async function selectBackend(page: Page, backend: InferenceProvider): Promise<void> {
  const option = page.getByTestId(`backend-option-${backend}`);
  await expect(option).toBeVisible();
  await option.locator('input[type="radio"]').check({ force: true });
  await expect(option.locator('input[type="radio"]')).toBeChecked();
  await expect(page.getByTestId('selected-backend-setup')).toBeVisible();
}

async function deselectDefaultApps(page: Page): Promise<void> {
  const openClaw = page.getByTestId('agent-openclaw');
  if ((await openClaw.getAttribute('aria-pressed')) === 'true') {
    await openClaw.click();
  }
  await expect(openClaw).toHaveAttribute('aria-pressed', 'false');

  const companionMemory = page.getByRole('checkbox', { name: 'Companion Memory' });
  await expect(companionMemory).toHaveCount(1);
  await expect(companionMemory).toBeEnabled();
  if (await companionMemory.isChecked()) {
    await companionMemory.click({ force: true });
  }
  await expect(companionMemory).not.toBeChecked();
}

async function deselectVisibleModels(page: Page): Promise<void> {
  const selected = page.locator('input[data-testid^="model-checkbox-"]:checked');
  while ((await selected.count()) > 0) {
    await selected.first().uncheck({ force: true });
  }
}

async function prepareNoWorkSetup(page: Page): Promise<void> {
  await deselectDefaultApps(page);
  await deselectVisibleModels(page);
  await expect(page.getByTestId('finish-setup-btn')).toBeEnabled();
}

async function aliasDockerFixtureAsOnlyOffice(page: Page): Promise<void> {
  await page.route('**/api/marketplace/apps/search**', async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
    payload.data = [
      {
        id: 'onlyoffice',
        name: 'OnlyOffice',
        short_desc: 'FTUE installer integration fixture',
        categories: ['utilities'],
        icon: null,
        urn: dockerFixtureUrn,
      },
      ...(payload.data ?? []).filter((app) => app.id !== 'onlyoffice'),
    ];
    await route.fulfill({ response, json: payload });
  });
}

async function finishAndWaitForDone(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('finish-setup-btn')).toBeEnabled();
  await page.getByTestId('finish-setup-btn').click();
  await expect(page.getByTestId('install-progress-text')).toBeVisible();
  await expect(page.getByTestId('install-continue-btn')).toHaveText(/^Continue$/, { timeout });
}

async function completeAndOpenHome(page: Page): Promise<void> {
  await page.getByTestId('install-continue-btn').click();
  await expect(page).toHaveURL(/\/home(?:[/?#]|$)/, { timeout: 30_000 });
}

function groupForModel(model: CuratedModelFixture): string {
  if (model.modality === 'embedding') return 'other-group-embedding';
  if (model.modality !== 'llm') return 'other-group-other';
  if ((model.parameterScale ?? 0) > 70) return 'other-group-large';
  if ((model.parameterScale ?? 0) > 14) return 'other-group-medium';
  return 'other-group-small';
}

async function makeModelCheckboxVisible(page: Page, model: CuratedModelFixture): Promise<void> {
  const checkbox = page.getByTestId(`model-checkbox-${model.id}`);
  if ((await checkbox.count()) > 0) return;

  const group = page.getByTestId(groupForModel(model));
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await expect(checkbox).toBeAttached();
}

async function pickFreshModel(page: Page, backend: InferenceProvider, testInfo: TestInfo): Promise<CuratedModelFixture> {
  const [profile, tracked] = await Promise.all([fetchProfile(page, backend), fetchTrackedModels(page)]);
  const unavailable = new Set([
    ...profile.installedCatalogIds,
    ...tracked.filter((model) => terminalModelStates.has(model.state)).map((model) => model.catalogId),
  ]);
  const models = [...profile.recommendedModels, ...profile.availableModels]
    .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index)
    .filter((model) => model.backend === backend && model.modality === 'llm' && !unavailable.has(model.id))
    .sort((left, right) => left.requirements.diskMb - right.requirements.diskMb);

  expect(models.length, `Expected a fresh ${backend} LLM in the deterministic Apple-Silicon catalog`).toBeGreaterThan(0);
  return models[testInfo.retry % models.length] as CuratedModelFixture;
}

async function dockerFixtureIds(): Promise<string[]> {
  try {
    const { stdout } = await execFile('docker', ['ps', '-aq', '--filter', `label=${dockerServiceLabel}`]);
    return stdout
      .trim()
      .split(/\s+/)
      .filter((id) => /^[a-f0-9]{12,64}$/i.test(id));
  } catch {
    return [];
  }
}

async function dockerProjectResourceIds(resource: 'network' | 'volume'): Promise<string[]> {
  try {
    const { stdout } = await execFile('docker', [resource, 'ls', '-q', '--filter', `label=${dockerProjectLabel}`]);
    return stdout
      .trim()
      .split('\n')
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function dockerFixtureResources(): Promise<{ containers: string[]; networks: string[]; volumes: string[] }> {
  const [containers, networks, volumes] = await Promise.all([
    dockerFixtureIds(),
    dockerProjectResourceIds('network'),
    dockerProjectResourceIds('volume'),
  ]);
  return { containers, networks, volumes };
}

function hasDockerFixtureResources(resources: { containers: string[]; networks: string[]; volumes: string[] }): boolean {
  return resources.containers.length + resources.networks.length + resources.volumes.length > 0;
}

async function dockerFixtureImages(): Promise<string[]> {
  const { stdout } = await execFile('docker', ['ps', '--filter', `label=${dockerServiceLabel}`, '--format', '{{.Image}}']);
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function cleanupDockerFixture(page: Page): Promise<void> {
  const before = await dockerFixtureResources();
  if (!hasDockerFixtureResources(before)) return;

  await page.request
    .delete(`/api/app-lifecycle/${encodeURIComponent(dockerFixtureUrn)}/uninstall`, {
      data: { deleteAllData: true, force: true },
    })
    .catch(() => undefined);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && hasDockerFixtureResources(await dockerFixtureResources())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Last-resort cleanup is intentionally scoped to the exact E2E service and project labels.
  const remaining = await dockerFixtureResources();
  for (const id of remaining.containers) {
    await execFile('docker', ['rm', '-f', id]).catch(() => undefined);
  }
  for (const id of remaining.networks) {
    await execFile('docker', ['network', 'rm', id]).catch(() => undefined);
  }
  for (const id of remaining.volumes) {
    await execFile('docker', ['volume', 'rm', id]).catch(() => undefined);
  }

  expect(await dockerFixtureResources()).toEqual({ containers: [], networks: [], volumes: [] });
}

async function installDesktopTauriBridge(page: Page): Promise<void> {
  await page.evaluate(
    ({ controlUrl, baseUrl }) => {
      type RunnerCall = { command: string; backends: string[] };
      type TauriWindow = Window & {
        __ftueRunnerCalls: RunnerCall[];
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      };

      const target = window as TauriWindow;
      target.__ftueRunnerCalls = [];
      target.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command !== 'install_and_start_inference_runners_command') return null;
          const backends = Array.isArray(args?.backends) ? (args.backends as string[]) : [];
          target.__ftueRunnerCalls.push({ command, backends });

          const managedProviders = Object.fromEntries(
            backends
              .filter((backend) => backend === 'dspark' || backend === 'mtplx' || backend === 'vllm')
              .map((backend) => [backend, { online: true }]),
          );
          if (Object.keys(managedProviders).length > 0) {
            await fetch(`${controlUrl}/configure`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ providers: managedProviders }),
            });
          }

          const endpoints: Record<string, string> = {
            dspark: `${baseUrl}/dspark`,
            mtplx: `${baseUrl}/mtplx`,
            vllm: `${baseUrl}/vllm`,
            ollama: `${baseUrl}/ollama`,
            lucebox: `${baseUrl}/lucebox`,
          };
          return backends.map((runner) => ({
            runner,
            state: 'installed_and_started',
            endpointUrl: endpoints[runner],
          }));
        },
      };
    },
    { controlUrl: `${inferenceFixtureUrl}/___control`, baseUrl: inferenceFixtureUrl },
  );
}

test.describe('FTUE full integration', () => {
  test.beforeEach(async () => {
    await resetInferenceFixture();
  });

  test.afterEach(async ({ page }) => {
    await cleanupDockerFixture(page);
  });

  test('[FTUE-E2E-001] renders the current one-page setup with deterministic Apple-Silicon recommendations', async ({ page }) => {
    await registerAndOpenFtue(page);

    const profile = await fetchProfile(page);
    expect(profile.tier).toBe('high');
    expect(profile.hardware.cpu.model).toContain('Apple M2 Ultra');
    expect(profile.hardware.cpu.arch).toBe('arm64');
    expect(profile.hardware.os.platform).toBe('darwin');
    expect(profile.backends.recommended).toBe('dspark');

    await expect(page.getByTestId('onboarding-brand-mark').locator('img')).toHaveAttribute('src', '/brands/ci-server-e-brain.png');
    await expect(page.getByTestId('tier-badge')).toContainText('Apple Silicon');
    await expect(page.getByTestId('inference-setup-section')).toBeVisible();
    await expect(page.getByTestId('model-card-title')).toBeVisible();
    await expect(page.getByTestId('companion-memory-option')).toBeVisible();
    await expect(page.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: 'Companion Memory' })).toBeChecked();

    const speculativeOptions = await page
      .getByTestId('backend-option-dspark-group')
      .locator('[data-testid^="backend-option-"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));
    expect(speculativeOptions.slice(0, 2)).toEqual(['backend-option-dspark', 'backend-option-mtplx']);
    await expect(page.getByTestId('backend-option-dspark').locator('input[type="radio"]')).toBeChecked();
    await expect(page.getByTestId('backend-option-lemonade')).toHaveCount(0);

    await expect(page.getByTestId('recommended-app')).toHaveCount(20);
    await expect(page.getByTestId('recommended-app-row-onlyoffice')).toBeVisible();
    await expect(page.getByTestId('recommended-private-icon-microsoft-office').locator('img')).toHaveAttribute('src', /.+/);
  });

  test('[FTUE-E2E-002] keeps the complete form selectable and above the sticky footer on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await registerAndOpenFtue(page);

    const alignment = await page.evaluate(() => {
      const logo = document.querySelector('[data-testid="onboarding-brand-mark"]')?.getBoundingClientRect();
      const heading = Array.from(document.querySelectorAll('h1'))
        .find((element) => element.textContent?.includes('Set Up Companion Hub'))
        ?.getBoundingClientRect();
      return {
        centerDelta: logo && heading ? Math.abs(logo.left + logo.width / 2 - (heading.left + heading.width / 2)) : Number.POSITIVE_INFINITY,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(alignment.centerDelta).toBeLessThanOrEqual(2);
    expect(alignment.horizontalOverflow).toBeLessThanOrEqual(1);

    const memoryCheckbox = page.getByRole('checkbox', { name: 'Companion Memory' });
    await expect(memoryCheckbox).toHaveCount(1);
    await memoryCheckbox.scrollIntoViewIfNeeded();
    await memoryCheckbox.uncheck({ force: true });
    await expect(memoryCheckbox).not.toBeChecked();
    await memoryCheckbox.check({ force: true });
    await expect(memoryCheckbox).toBeChecked();

    const finalRecommendation = page.getByTestId('recommended-app').last();
    await finalRecommendation.scrollIntoViewIfNeeded();
    await finalRecommendation.locator('input[type="checkbox"]').check({ force: true });
    await expect(finalRecommendation.locator('input[type="checkbox"]')).toBeChecked();

    const visibility = await page.evaluate(() => {
      const finalRow = document.querySelectorAll('[data-testid="recommended-app"]');
      const rowBox = finalRow.item(finalRow.length - 1).getBoundingClientRect();
      const footerBox = document.querySelector('[data-testid="finish-setup-btn"]')?.parentElement?.parentElement?.getBoundingClientRect();
      return { rowBottom: rowBox.bottom, footerTop: footerBox?.top ?? window.innerHeight };
    });
    expect(visibility.rowBottom).toBeLessThanOrEqual(visibility.footerTop + 1);
  });

  test('[FTUE-E2E-003] recovers MTPLX with the desktop installer and persists its operator endpoint', async ({ page }) => {
    await configureInferenceProvider('mtplx', { online: false });
    await registerAndOpenFtue(page);
    await selectBackend(page, 'mtplx');

    await expect(page.getByTestId('mtplx-probe-error')).toBeVisible();
    await installDesktopTauriBridge(page);
    await page.getByTestId('mtplx-recheck-btn').click();
    await expect(page.getByTestId('auto-install-runner-btn')).toBeVisible();
    await page.getByTestId('auto-install-runner-btn').click();
    await expect(page.getByTestId('auto-install-runner').getByRole('status')).toBeVisible();
    await expect(page.getByTestId('mtplx-probe-error')).not.toBeVisible({ timeout: 30_000 });

    const endpoint = `${inferenceFixtureUrl}/mtplx`;
    await expect(page.getByTestId('mtplx-endpoint-url-input')).toHaveValue(endpoint);
    await expect.poll(async () => (await recordedRequests('mtplx', '/mtplx/v1/models')).length).toBeGreaterThan(0);

    const runnerCalls = await page.evaluate(() => {
      return (window as Window & { __ftueRunnerCalls?: Array<{ backends: string[] }> }).__ftueRunnerCalls ?? [];
    });
    expect(runnerCalls.some((call) => call.backends.length === 1 && call.backends[0] === 'mtplx')).toBe(true);

    await deselectDefaultApps(page);
    await finishAndWaitForDone(page);

    await expect.poll(async () => (await fetchPreferences(page)).preferredBackend).toBe('mtplx');
    const preferences = await fetchPreferences(page);
    expect(preferences.preferredMtplxUrl).toBe(endpoint);
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-004] probes vLLM with the operator endpoint and API key before persisting both', async ({ page }) => {
    await registerAndOpenFtue(page);
    await selectBackend(page, 'vllm');

    const endpoint = `${inferenceFixtureUrl}/vllm`;
    const apiKey = 'synthetic-vllm-ftue-key';
    await page.getByTestId('vllm-endpoint-url-input').fill(endpoint);
    await page.getByTestId('vllm-api-key-input').fill(apiKey);
    await page.getByTestId('vllm-recheck-btn').click();

    await expect(page.getByTestId('vllm-probe-error')).not.toBeVisible();
    await expect(page.getByTestId('vllm-endpoint-url-input')).toHaveValue(endpoint);
    await expect.poll(async () => (await recordedRequests('vllm', '/vllm/v1/models')).length).toBeGreaterThan(0);
    const probes = await recordedRequests('vllm', '/vllm/v1/models');
    expect(probes.some((probe) => probe.headers.authorization === `Bearer ${apiKey}`)).toBe(true);

    await deselectDefaultApps(page);
    await finishAndWaitForDone(page);

    const preferences = await fetchPreferences(page);
    expect(preferences.preferredBackend).toBe('vllm');
    expect(preferences.preferredVllmUrl).toBe(endpoint);
    expect(preferences.preferredVllmApiKey).toBe(apiKey);
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-005] discovers Lucebox models through the external speculative-inference endpoint', async ({ page }) => {
    await registerAndOpenFtue(page);
    await selectBackend(page, 'lucebox');

    await page.getByTestId('speculative-inference-recheck-btn').click();
    await expect.poll(async () => (await recordedRequests('lucebox', '/lucebox/health')).length).toBeGreaterThan(0);
    await expect.poll(async () => (await recordedRequests('lucebox', '/lucebox/v1/models')).length).toBeGreaterThan(0);

    await prepareNoWorkSetup(page);
    await finishAndWaitForDone(page);
    await expect.poll(async () => (await fetchPreferences(page)).preferredBackend).toBe('lucebox');
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-006] recovers mlx-dspark with the desktop installer, loads a model, and starts Ollama alongside it', async ({ page }, testInfo) => {
    await configureInferenceProvider('dspark', { online: false, models: [], loadedModels: [] });
    await registerAndOpenFtue(page);

    await expect(page.getByTestId('dspark-probe-error')).toBeVisible();
    await installDesktopTauriBridge(page);
    await page.getByTestId('dspark-recheck-btn').click();
    await expect(page.getByTestId('auto-install-runner-btn')).toBeVisible();
    await page.getByTestId('auto-install-runner-btn').click();
    await expect(page.getByTestId('auto-install-runner').getByRole('status')).toBeVisible();
    await expect(page.getByTestId('dspark-probe-error')).not.toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('dspark-endpoint-url-input')).toHaveValue(`${inferenceFixtureUrl}/dspark`);

    const model = await pickFreshModel(page, 'dspark', testInfo);
    await makeModelCheckboxVisible(page, model);
    const checkbox = page.getByTestId(`model-checkbox-${model.id}`);
    await checkbox.check({ force: true });
    await expect(checkbox).toBeChecked();

    await expect.poll(async () => (await recordedRequests('dspark', '/dspark/admin/load')).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const firstLoad = (await recordedRequests('dspark', '/dspark/admin/load'))[0];
    expect(firstLoad?.body).toEqual({ model: model.backendModelId, confidence_threshold: 0, kv_bits: 0 });

    await deselectDefaultApps(page);
    await finishAndWaitForDone(page, 90_000);
    await expect.poll(async () => (await fetchPreferences(page)).preferredBackend).toBe('dspark');

    const preferences = await fetchPreferences(page);
    expect(preferences.preferredModel).toBe(model.id);
    expect(preferences.preferredDsparkUrl).toBe(`${inferenceFixtureUrl}/dspark`);

    const runnerCalls = await page.evaluate(() => {
      return (window as Window & { __ftueRunnerCalls?: Array<{ backends: string[] }> }).__ftueRunnerCalls ?? [];
    });
    expect(runnerCalls.some((call) => call.backends.length === 1 && call.backends[0] === 'dspark')).toBe(true);
    expect(runnerCalls.some((call) => call.backends.join(',') === 'dspark,ollama')).toBe(true);
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-007] streams an Ollama pull, pins the model, and saves it as the agent default', async ({ page }, testInfo) => {
    await registerAndOpenFtue(page);
    await selectBackend(page, 'ollama');

    const model = await pickFreshModel(page, 'ollama', testInfo);
    await makeModelCheckboxVisible(page, model);
    const checkbox = page.getByTestId(`model-checkbox-${model.id}`);
    await checkbox.check({ force: true });
    await expect(checkbox).toBeChecked();

    await expect.poll(async () => (await recordedRequests('ollama', '/ollama/api/pull')).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const pull = (await recordedRequests('ollama', '/ollama/api/pull'))[0];
    expect(pull?.body).toMatchObject({ name: model.backendModelId });
    await expect
      .poll(async () => (await fetchTrackedModels(page)).find((entry) => entry.catalogId === model.id)?.state, { timeout: 30_000 })
      .toMatch(/pulled|loaded|pinned/);

    await deselectDefaultApps(page);
    await finishAndWaitForDone(page, 90_000);
    await expect.poll(async () => (await recordedRequests('ollama', '/ollama/api/generate')).length).toBeGreaterThan(0);

    const preferences = await fetchPreferences(page);
    expect(preferences.preferredBackend).toBe('ollama');
    expect(preferences.preferredModel).toBe(model.id);
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-008] installs a selected recommendation through the backend queue into a real Docker container', async ({ page }) => {
    test.slow();
    await execFile('docker', ['info']);
    await aliasDockerFixtureAsOnlyOffice(page);
    await registerAndOpenFtue(page);
    await prepareNoWorkSetup(page);

    const onlyOffice = page.getByTestId('recommended-app-checkbox-onlyoffice');
    await onlyOffice.scrollIntoViewIfNeeded();
    await onlyOffice.check({ force: true });
    await expect(onlyOffice).toBeChecked();

    const installResponsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/api/app-lifecycle/') && response.url().endsWith('/install'),
    );
    await page.getByTestId('finish-setup-btn').click();
    const installResponse = await installResponsePromise;
    expect(installResponse.ok(), `${installResponse.status()} ${installResponse.url()} ${await installResponse.text()}`).toBe(true);
    expect(decodeURIComponent(installResponse.url())).toContain(dockerFixtureUrn);
    const row = page.getByTestId('install-row-onlyoffice');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('status-running')).toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => (await dockerFixtureIds()).length, { timeout: 30_000 }).toBe(1);
    expect(await dockerFixtureImages()).toEqual([expect.stringContaining('busybox')]);

    await expect(page.getByTestId('install-continue-btn')).toHaveText(/^Continue$/);
    await completeAndOpenHome(page);
  });

  test('[FTUE-E2E-009] retries a transient completion failure once before opening Home', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/complete-onboarding', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'synthetic restart' }) });
        return;
      }
      await route.continue();
    });

    await registerAndOpenFtue(page);
    await prepareNoWorkSetup(page);
    await finishAndWaitForDone(page);
    await completeAndOpenHome(page);
    expect(attempts).toBe(2);
    await expect(page.getByTestId('onboarding-complete-failed')).not.toBeVisible();
  });

  test('[FTUE-E2E-010] does not auto-retry a validation failure and lets the operator retry manually', async ({ page }) => {
    let attempts = 0;
    let failValidation = true;
    await page.route('**/api/complete-onboarding', async (route) => {
      attempts += 1;
      if (failValidation) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'synthetic validation failure' }) });
        return;
      }
      await route.continue();
    });

    await registerAndOpenFtue(page);
    await prepareNoWorkSetup(page);
    await finishAndWaitForDone(page);
    await page.getByTestId('install-continue-btn').click();

    await expect(page.getByTestId('onboarding-complete-failed')).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding(?:[/?#]|$)/);
    expect(attempts).toBe(1);

    failValidation = false;
    await completeAndOpenHome(page);
    expect(attempts).toBe(2);
  });
});
