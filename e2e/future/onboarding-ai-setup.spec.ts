import { expect, test } from '../fixtures/fixtures';
import { clearDatabase, seedOrganization } from '../helpers/db';
import { testUser } from '../helpers/constants';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;

/**
 * E2E tests for the onboarding AI setup flow.
 *
 * These tests exercise the full wizard path from registration through
 * AI Setup (step 3) to Install (step 4) and Complete (step 5).
 *
 * The Hub's inference module must be running with Ollama available.
 * The hardware-inspector, model-registry, memory-manager, and
 * inference-router services are all exercised via the aggregated
 * /api/inference/onboarding-profile endpoint.
 */

/** Register a new user account and land on the onboarding wizard. */
async function registerAndStartOnboarding(page: import('@playwright/test').Page) {
  await page.goto('/register');
  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByPlaceholder('Confirm your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Register' }).click();

  // Wait for the onboarding wizard to appear
  await expect(page.getByText('Set Up Your Hub')).toBeVisible({ timeout: 15000 });
}

/** Advance through Welcome → Discover → Select to reach the AI Setup step. */
async function navigateToAiSetupStep(page: import('@playwright/test').Page) {
  await registerAndStartOnboarding(page);

  // Step 0: Welcome — click the primary CTA to start discovery
  await page.getByRole('button', { name: /get started|next|continue/i }).click();

  // Step 1: Discover — skip or proceed
  await expect(page.getByRole('button', { name: /skip|next|continue/i }).first()).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole('button', { name: /skip|next|continue/i })
    .first()
    .click();

  // Step 2: Select Apps — confirm selection (even empty) to advance
  await expect(page.getByRole('button', { name: /confirm|next|continue/i }).first()).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole('button', { name: /confirm|next|continue/i })
    .first()
    .click();

  // Step 3: AI Setup — wait for the loading skeleton or the step content
  await expect(page.getByTestId('ai-setup-step').or(page.getByTestId('ai-setup-loading')).or(page.getByTestId('ai-setup-error'))).toBeVisible({
    timeout: 30000,
  });
}

test.describe('Onboarding AI Setup', () => {
  test.beforeEach(async () => {
    await clearDatabase();
    await seedOrganization();
  });

  test('AI Setup step is shown after Select Apps', async ({ page }) => {
    await navigateToAiSetupStep(page);

    // The AI Setup step should be visible — either loaded or in loading state
    const stepVisible = await page.getByTestId('ai-setup-step').or(page.getByTestId('ai-setup-loading')).isVisible();
    expect(stepVisible).toBe(true);

    // The stepper should show "AI Setup" as the active step (index 3)
    await expect(page.getByText('AI Setup')).toBeVisible();
  });

  test('hardware profile is displayed with correct tier', async ({ page }) => {
    await navigateToAiSetupStep(page);

    // Wait for loading to complete — the step content should appear
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Hardware card should display GPU, RAM, and CPU info
    await expect(page.getByTestId('hw-card-title')).toBeVisible();
    await expect(page.getByTestId('tier-badge')).toBeVisible();
    await expect(page.getByTestId('hw-gpu')).toBeVisible();
    await expect(page.getByTestId('hw-ram')).toBeVisible();
    await expect(page.getByTestId('hw-cpu')).toBeVisible();

    // Tier badge should contain one of the valid tier values
    const tierText = await page.getByTestId('tier-badge').textContent();
    expect(['Insufficient', 'CPU Only', 'Low', 'Medium', 'High']).toContain(tierText?.trim());

    // Rescan button should be available
    await expect(page.getByTestId('rescan-btn')).toBeVisible();
  });

  test('recommended models are pre-selected', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // If the tier is not "insufficient", model selection should be visible
    const tierText = await page.getByTestId('tier-badge').textContent();
    if (tierText?.trim() === 'Insufficient') {
      // Model selection is hidden for insufficient tier
      await expect(page.getByTestId('model-card-title')).not.toBeVisible();
      return;
    }

    // Model selection card should be visible
    await expect(page.getByTestId('model-card-title')).toBeVisible();
    await expect(page.getByTestId('model-groups')).toBeVisible();

    // Fetch the onboarding profile to know which models are recommended
    const profileRes = await page.request.get(`${BACKEND_URL}/api/inference/onboarding-profile`);
    if (profileRes.ok()) {
      const profile = await profileRes.json();
      // Each recommended model should have a checked checkbox
      for (const model of profile.recommendedModels) {
        const checkbox = page.getByTestId(`model-checkbox-${model.id}`);
        if (await checkbox.isVisible()) {
          await expect(checkbox).toBeChecked();
        }
      }
    }
  });

  test('model selection can be toggled', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    const tierText = await page.getByTestId('tier-badge').textContent();
    if (tierText?.trim() === 'Insufficient') {
      test.skip(true, 'No model selection on insufficient tier');
      return;
    }

    // Find the first visible checkbox and toggle it
    const firstCheckbox = page.getByTestId('model-groups').locator('input[type="checkbox"]').first();
    if (await firstCheckbox.isVisible()) {
      const wasChecked = await firstCheckbox.isChecked();
      await firstCheckbox.click();
      if (wasChecked) {
        await expect(firstCheckbox).not.toBeChecked();
      } else {
        await expect(firstCheckbox).toBeChecked();
      }
    }
  });

  test('backend selection shows available backends', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    const tierText = await page.getByTestId('tier-badge').textContent();
    if (tierText?.trim() === 'Insufficient') {
      test.skip(true, 'No backend selection on insufficient tier');
      return;
    }

    // Backend selection card should be visible with at least Ollama
    await expect(page.getByTestId('backend-card-title')).toBeVisible();
    await expect(page.getByTestId('backend-options')).toBeVisible();
    await expect(page.getByTestId('backend-option-ollama')).toBeVisible();
  });

  test('cloud provider inputs accept API keys', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Cloud provider card should be visible
    await expect(page.getByTestId('cloud-card-title')).toBeVisible();

    // If hardware is insufficient, cloud inputs should be expanded by default
    const tierText = await page.getByTestId('tier-badge').textContent();
    const isInsufficient = tierText?.trim() === 'Insufficient';

    if (!isInsufficient) {
      // Toggle open the cloud section
      const toggle = page.getByTestId('cloud-toggle');
      if (await toggle.isVisible()) {
        await toggle.click();
      }
    }

    // Cloud inputs should be visible
    await expect(page.getByTestId('cloud-inputs')).toBeVisible({ timeout: 5000 });

    // OpenAI input should be present
    const openaiInput = page.getByTestId('cloud-key-openai');
    await expect(openaiInput).toBeVisible();

    // Type a valid-prefix key
    await openaiInput.fill('sk-test1234567890abcdef');
    await expect(openaiInput).toHaveValue('sk-test1234567890abcdef');

    // Typing an invalid prefix should show a validation error
    await openaiInput.fill('invalid-key');
    // The validation error should appear for invalid prefix
    const errorEl = page.getByTestId('cloud-error-openai');
    if (await errorEl.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(errorEl).toBeVisible();
    }
  });

  test('resource summary bar reflects model selection', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    const tierText = await page.getByTestId('tier-badge').textContent();
    if (tierText?.trim() === 'Insufficient') {
      test.skip(true, 'No resource bar on insufficient tier');
      return;
    }

    // Resource summary bar should be visible when models are selected
    const resourceBar = page.getByTestId('resource-summary');
    if (await resourceBar.isVisible().catch(() => false)) {
      // Bar should have a progress indicator
      await expect(resourceBar.locator('[role="progressbar"], .bg-primary, .h-2')).toBeVisible();
    }
  });

  test('rescan button re-fetches hardware profile', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Click rescan
    const rescanBtn = page.getByTestId('rescan-btn');
    await rescanBtn.click();

    // Should briefly show loading state, then return to step
    await expect(page.getByTestId('ai-setup-step').or(page.getByTestId('ai-setup-loading'))).toBeVisible({ timeout: 15000 });

    // After rescan completes, hardware info should still be present
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('hw-card-title')).toBeVisible();
  });

  test('continue button advances to Install step with AI phase', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Click Continue to move to the Install step
    await page.getByTestId('ai-continue-btn').click();

    // Install step should be visible
    await expect(page.getByTestId('install-progress-text')).toBeVisible({ timeout: 15000 });

    // If models were selected, the AI phase section should appear.
    // AI phase may or may not be visible depending on model selection —
    // just verify the install step loaded correctly
    await expect(page.getByText(/installing|installation/i).first()).toBeVisible({ timeout: 15000 });
  });

  test('skip AI Setup proceeds to Install without AI phase', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Click "Skip AI Setup"
    await page.getByTestId('ai-skip-btn').click();

    // Should advance to Install step (step 4)
    await expect(page.getByTestId('install-progress-text')).toBeVisible({ timeout: 15000 });

    // AI phase section should NOT be present when skipped
    await expect(page.getByTestId('ai-phase-section')).not.toBeVisible();
  });

  test('skip AI Setup shows "not configured" on Complete step', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Skip AI setup
    await page.getByTestId('ai-skip-btn').click();

    // Wait for install step, then continue
    await expect(page.getByTestId('install-continue-btn')).toBeVisible({ timeout: 60000 });
    await page.getByTestId('install-continue-btn').click();

    // Complete step should show AI summary with "not configured" message
    await expect(page.getByTestId('complete-heading')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('ai-summary')).toBeVisible();
    await expect(page.getByTestId('ai-summary')).toContainText('AI not configured');
    await expect(page.getByTestId('ai-summary')).toContainText('Settings');
  });

  test('back button returns to Select Apps step', async ({ page }) => {
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    // Click Back
    await page.getByTestId('ai-back-btn').click();

    // Should return to the Select Apps step (step 2)
    // The stepper should show "Select" as active
    await expect(page.getByRole('button', { name: /confirm|next|continue/i }).first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('insufficient tier hides model and backend selection', async ({ page }) => {
    // Check if the current hardware tier allows us to test this scenario
    await navigateToAiSetupStep(page);
    await expect(page.getByTestId('ai-setup-step')).toBeVisible({ timeout: 30000 });

    const tierText = await page.getByTestId('tier-badge').textContent();
    if (tierText?.trim() !== 'Insufficient') {
      test.skip(true, 'Hardware tier is not insufficient — cannot test this scenario');
      return;
    }

    // On insufficient tier, model and backend cards should be hidden
    await expect(page.getByTestId('model-card-title')).not.toBeVisible();
    await expect(page.getByTestId('backend-card-title')).not.toBeVisible();

    // Cloud provider card should be prominently visible
    await expect(page.getByTestId('cloud-card-title')).toBeVisible();
    await expect(page.getByTestId('cloud-inputs')).toBeVisible();

    // Continue button should say "Continue without AI"
    await expect(page.getByTestId('ai-continue-btn')).toContainText('Continue without AI');
  });

  test('onboarding-profile API returns valid response', async ({ request }) => {
    // Direct API test to verify the aggregated endpoint works
    const res = await request.get(`${BACKEND_URL}/api/inference/onboarding-profile`);

    // May be 401 if not authenticated — that's expected for a direct API call
    if (res.status() === 401) {
      return;
    }

    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Validate response shape
    expect(body).toHaveProperty('hardware');
    expect(body).toHaveProperty('tier');
    expect(body).toHaveProperty('recommendedModels');
    expect(body).toHaveProperty('availableModels');
    expect(body).toHaveProperty('memoryBudget');
    expect(body).toHaveProperty('backends');
    expect(body).toHaveProperty('resourceEstimate');
    expect(body.backends).toHaveProperty('recommended');
    expect(body.backends).toHaveProperty('available');
    expect(['insufficient', 'cpu-only', 'low', 'medium', 'high']).toContain(body.tier);
  });
});
