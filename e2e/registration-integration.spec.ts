import { test, expect } from '@playwright/test';
import { testUser } from './helpers/constants';

test.describe('Device Registration Integration', () => {
  test('should register device via CI Cloud redirect flow', async ({ page }) => {
    // 1. Navigate to Hub
    // We assume the Hub is in a state requiring registration (fresh install or reset)
    // If not, we might need to reset 'settings.json' or mock the state.
    // For this test script, we assume the environment is prepared.
    await page.goto('/');

    // Verify we are on the registration page intersitial
    // Note: If the user is not logged in / setup, they might see Setup / Login first.
    // But Registration usually happens after Setup. 
    // Let's assume we land on /device-registration if the guard redirects there.
    
    // If we are at login, login first?
    if (await page.getByText('Sign in to your account').isVisible()) {
       await page.getByLabel('Email Address').fill(testUser.email);
       await page.getByLabel('Password').fill(testUser.password);
       await page.getByRole('button', { name: 'Login' }).click();
    }
    
    // Check for Registration Prompt
    // It might be an alert or a redirect to /device-registration
    // If we are not registered, any authorized route usually redirects or blocks?
    // Let's force navigate to check the UI
    await page.goto('/device-registration');

    await expect(page.getByText('Device Registration Required')).toBeVisible();

    // 2. Click Register - verifying it goes to Cloud
    // We need to handle the external navigation
    // Note: In local dev, Cloud might be on localhost:5173
    
    await page.getByRole('button', { name: 'Register Device on CI Cloud' }).click();
    
    // Wait for navigation to Cloud
    await page.waitForURL(/.*device\/register.*/);
    
    // 3. Cloud Interaction
    // Login to Cloud if needed
    if (await page.getByText('Sign in to your account').isVisible()) {
        // Use Cloud test credentials (might be same if seeded)
        await page.getByPlaceholder('name@example.com').fill('test@test.com');
        await page.getByPlaceholder('password').fill('password');
        await page.getByRole('button', { name: 'Sign In' }).click();
    }
    
    // Register Page on Cloud
    await expect(page.getByText('Register New Device')).toBeVisible();
    
    // Click Register (assuming form is pre-filled)
    await page.getByRole('button', { name: 'Register' }).click();
    
    // 4. Verify Redirect Back
    // The Cloud should redirect back to Hub /device-registration?callback=...
    await page.waitForURL(/.*device-registration.*/);
    
    // 5. Verify Hub Success
    await expect(page.getByText('Device registered successfully!')).toBeVisible();
    await expect(page.getByText('Completing Registration...')).not.toBeVisible();
    
    // Should eventually navigate to Dashboard
    await page.waitForURL('**/dashboard');
  });
});
