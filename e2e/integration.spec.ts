import { test as base, expect } from '@playwright/test';
import { clearDatabase, db } from './helpers/db';
import { testUser } from './helpers/constants';
import { execSync } from 'child_process';
import * as schema from '../packages/backend/src/core/database/drizzle/schema';

const test = base.extend({
  page: async ({ page }, use) => {
    // 1. Clear Data
    await clearDatabase();
    
    // 2. Restart Backend to clear in-memory registration state
    console.log('Restarting ci-os-hub to clear memory state...');
    try {
        execSync('docker restart ci-os-hub', { stdio: 'inherit' });
    } catch (e) {
        console.error('Failed to restart docker container', e);
    }
    
    // 3. Wait for Healthy
    console.log('Waiting for backend health...');
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch('http://localhost:3000/api/health'); // Use mapped port
            if (res.ok) {
                console.log('Backend is up!');
                break;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
    }

    // 4. Create User (skip registration UI)
    await db.insert(schema.user).values({ 
        password: testUser.hashedPassword, 
        username: testUser.email, 
        operator: true, 
        hasSeenWelcome: true
    });

    await use(page);
  },
});

test('Integration: Hub to Cloud Connection', async ({ page }) => {
  test.setTimeout(120000);
  page.on('console', msg => console.log('BROWSER_CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER_ERROR:', err));

  // 1. Initial Navigation
  console.log('Navigating to Login...');
  await page.goto('/login');
  await page.waitForTimeout(5000);
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // 2. Handle Registration Redirect
  if (currentUrl.includes('/device-registration')) {
      console.log('Redirected to Device Registration. Proceeding with Link...');
      const registerText = 'Register Device on CI Cloud';
      await expect(page.getByText(registerText)).toBeVisible({ timeout: 10000 });
      await page.getByText(registerText).click();
      
      await page.waitForURL(/localhost:8000/, { timeout: 15000 });
      console.log('Successfully redirected to Local Cloud (localhost:8000)');
      return; // Success
  }

  // 3. Normal Login Flow
  console.log('Proceeding with Login...');
  await page.getByPlaceholder('you@example.com').fill(testUser.email);
  await page.getByPlaceholder('Enter your password').fill(testUser.password);
  await page.getByRole('button', { name: 'Login' }).click();
  
  await expect(page.getByText('Disk space')).toBeVisible();

  // 4. Go to App Store
  console.log('Navigating to App Store...');
  await page.goto('/app-store');
  
  // 5. Check for Registration Prompt
  try {
    const registerText = 'Register Device on CI Cloud';
    await expect(page.getByText(registerText)).toBeVisible({ timeout: 10000 });
    console.log('Registration prompt visible.');
    
    await page.getByText(registerText).click();
    
    await page.waitForURL(/localhost:8000/, { timeout: 10000 });
    console.log('Successfully redirected to Local Cloud (localhost:8000)');
    
  } catch (e) {
    console.log('Registration prompt NOT found or Redirect failed.');
    console.log('Current URL:', page.url());
    throw e;
  }
});
