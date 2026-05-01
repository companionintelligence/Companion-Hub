import { test } from '@playwright/test';

/**
 * Future e2e tests for the full onboarding AI setup flow.
 * Requires a running Ollama instance to test model pull + pin.
 * These tests are placed in `future/` and skipped by default.
 */

test.describe('Onboarding AI Setup (requires Ollama)', () => {
  test.skip(true, 'Requires Ollama backend — run manually with OLLAMA_AVAILABLE=1');

  test('AI Setup step is shown after Select Apps', async ({ page: _page }) => {
    // Navigate to onboarding
    // Complete welcome, discover, select steps
    // Verify AI Setup step is visible at index 3
  });

  test('hardware profile is displayed with correct tier', async ({ page: _page }) => {
    // Navigate to AI Setup step
    // Verify hardware card shows GPU/RAM/CPU info
    // Verify tier badge is rendered
  });

  test('recommended models are pre-selected', async ({ page: _page }) => {
    // Navigate to AI Setup step
    // Verify recommended model checkboxes are checked
  });

  test('model pull and pin completes during Install step', async ({ page: _page }) => {
    // Complete AI Setup with a small model
    // Verify Install step shows AI phase progress
    // Verify model pull progress updates
    // Verify pinning completes
  });

  test('skip AI Setup proceeds to Install without AI phase', async ({ page: _page }) => {
    // Navigate to AI Setup step
    // Click "Skip AI Setup"
    // Verify Install step does not show AI phase section
  });
});
