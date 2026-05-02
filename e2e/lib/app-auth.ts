/**
 * app-auth.ts
 *
 * Account creation and login on a freshly installed self-hosted app.
 * Structured detection first, AI fallback second.
 *
 * Uses test credentials from env (APP_TEST_*).
 * Auth result is returned and recorded in the report — it never throws.
 */

import type { Page } from '@playwright/test';

export type AuthMethod = 'already-authed' | 'signed-up' | 'logged-in' | 'ai-guided' | 'failed';

export interface AuthResult {
  success: boolean;
  method: AuthMethod;
  notes: string[];
}

// Test credentials for the self-hosted app (separate from hub credentials)
const EMAIL = process.env.APP_TEST_EMAIL || 'explorer@ci.computer';
const PASSWORD = process.env.APP_TEST_PASSWORD || 'Explorer123!';
const NAME = process.env.APP_TEST_NAME || 'CI Explorer';

// Signals that we're already past auth
const INTERIOR_SIGNALS = ['dashboard', 'workspace', 'inbox', 'home', 'projects', 'settings', 'profile', 'welcome', 'getting started', 'overview'];

const FIELD_SELECTORS = {
  email: ['input[type="email"]', 'input[name*="email" i]', 'input[placeholder*="email" i]', 'input[id*="email" i]'],
  password: ['input[type="password"]'],
  name: ['input[name="name"]', 'input[placeholder*="full name" i]', 'input[placeholder*="your name" i]', 'input[id="name"]'],
  username: ['input[name*="username" i]', 'input[placeholder*="username" i]', 'input[id*="username" i]'],
  confirm: ['input[name*="confirm" i]', 'input[placeholder*="confirm" i]', 'input[name*="repeat" i]'],
};

async function findVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) return el;
  }
  return null;
}

async function fillIfFound(page: Page, selectors: string[], value: string, label: string, notes: string[]): Promise<boolean> {
  const el = await findVisible(page, selectors);
  if (!el) return false;
  await el.clear();
  await el.fill(value);
  notes.push(`Filled ${label}`);
  return true;
}

function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? '').catch(() => '');
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function attemptAppAuth(page: Page): Promise<AuthResult> {
  const notes: string[] = [];

  // ── 1. Already authenticated? ──
  const text = (await bodyText(page)).toLowerCase();
  const hasAuthForm = /sign.?in|log.?in|sign.?up|register|create.account/i.test(text);
  const hasInterior = INTERIOR_SIGNALS.some((s) => text.includes(s));

  if (hasInterior && !hasAuthForm) {
    notes.push('App interior detected — already authenticated');
    return { success: true, method: 'already-authed', notes };
  }

  // ── 2. Navigate to sign-up if we're on login ──
  const _isLoginPage = /sign.?in|log.?in/i.test(text);
  const isSignUpPage = /sign.?up|register|create.account/i.test(text);

  if (!isSignUpPage) {
    const signUpLink = page.getByRole('link', { name: /sign.?up|register|create.account|get.started/i }).first();
    const signUpBtn = page.getByRole('button', { name: /sign.?up|register|create.account/i }).first();
    if (await signUpLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await signUpLink.click();
      await page.waitForTimeout(1200);
      notes.push('Navigated to sign-up via link');
    } else if (await signUpBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await signUpBtn.click();
      await page.waitForTimeout(1200);
      notes.push('Navigated to sign-up via button');
    }
  }

  // ── 3. Fill the form ──
  const filledEmail = await fillIfFound(page, FIELD_SELECTORS.email, EMAIL, 'email', notes);
  const filledPassword = await fillIfFound(page, FIELD_SELECTORS.password, PASSWORD, 'password', notes);
  await fillIfFound(page, FIELD_SELECTORS.name, NAME, 'name', notes);
  await fillIfFound(page, FIELD_SELECTORS.username, EMAIL.split('@')[0], 'username', notes);
  await fillIfFound(page, FIELD_SELECTORS.confirm, PASSWORD, 'confirm', notes);

  if (filledEmail && filledPassword) {
    // Submit
    const submitBtn = page
      .getByRole('button', {
        name: /sign.?up|register|create|submit|continue|next|get.started/i,
      })
      .first();

    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
      notes.push('Submitted sign-up form');
      await page.waitForTimeout(3000);

      const afterText = (await bodyText(page)).toLowerCase();
      const hasError = /invalid|error|already.exists|taken|required|failed/i.test(afterText);

      if (!hasError) {
        return { success: true, method: 'signed-up', notes };
      }

      // Account likely exists — try login
      notes.push('Sign-up error detected — attempting login with same credentials');
      await fillIfFound(page, FIELD_SELECTORS.email, EMAIL, 'email (login)', notes);
      await fillIfFound(page, FIELD_SELECTORS.password, PASSWORD, 'password (login)', notes);

      const loginBtn = page.getByRole('button', { name: /sign.?in|log.?in|login|continue/i }).first();
      if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await loginBtn.click();
        await page.waitForTimeout(3000);
        notes.push('Submitted login form');
        return { success: true, method: 'logged-in', notes };
      }
    }
  }

  // ── 4. AI fallback ──
  notes.push('Structured auth detection failed — using AI fallback');
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });

      for (let i = 0; i < 8; i++) {
        const url = page.url();
        const title = await page.title();
        const visible = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll('button, a, input, select'))
              .slice(0, 25)
              .map((el) => ({
                tag: el.tagName.toLowerCase(),
                text: (el as HTMLElement).innerText?.slice(0, 50),
                type: (el as HTMLInputElement).type,
                placeholder: (el as HTMLInputElement).placeholder,
              })),
          )
          .catch(() => []);

        const res = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: `Create an account on this app. Email: ${EMAIL}, Password: ${PASSWORD}, Name: ${NAME}.\nURL: ${url}\nTitle: ${title}\nElements: ${JSON.stringify(visible)}\nRespond with JSON: { "type": "click"|"fill", "selector": "css", "value": "..." , "description": "..." }`,
            },
          ],
        });

        const raw = res.choices[0].message.content || '{}';
        const action = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}') as {
          type?: string;
          selector?: string;
          value?: string;
          description?: string;
        };

        try {
          if (action.type === 'fill' && action.selector) {
            await page
              .locator(action.selector)
              .first()
              .fill(action.value ?? '', { timeout: 3000 });
          } else if (action.type === 'click' && action.selector) {
            await page.locator(action.selector).first().click({ timeout: 3000 });
          }
          await page.waitForTimeout(800);
          notes.push(`AI: ${action.description ?? action.type}`);
        } catch {
          // action failed — continue loop
        }

        const interior = (await bodyText(page)).toLowerCase();
        if (INTERIOR_SIGNALS.some((s) => interior.includes(s))) {
          notes.push('AI auth succeeded');
          return { success: true, method: 'ai-guided', notes };
        }
      }
    } catch (e: unknown) {
      notes.push(`AI fallback error: ${(e as Error).message}`);
    }
  }

  notes.push('Auth failed — could not sign up or log in');
  return { success: false, method: 'failed', notes };
}
