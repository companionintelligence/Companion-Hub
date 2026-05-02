/**
 * ai-explorer.ts
 *
 * AI-directed interaction loop. Runs for a fixed duration after the app
 * is loaded and authenticated. Uses GPT-4o-mini to decide what to do next;
 * falls back to a simple heuristic if no API key.
 */

import type { Page } from '@playwright/test';

export interface ExplorerSession {
  actions:      Array<{ type: string; description: string; ok: boolean }>;
  observations: string[];
  errors:       string[];
}

export interface ExploreResult {
  actionsCount:      number;
  observationsCount: number;
  errorsCount:       number;
  errors:            string[];
  durationMs:        number;
  session:           ExplorerSession;
}

async function getPageState(page: Page) {
  const url   = page.url();
  const title = await page.title().catch(() => '');
  const elems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, [role="button"]'))
      .slice(0, 30)
      .map(el => ({
        tag:         el.tagName.toLowerCase(),
        text:        (el as HTMLElement).innerText?.slice(0, 60).trim(),
        type:        (el as HTMLInputElement).type || undefined,
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        href:        (el as HTMLAnchorElement).href || undefined,
      }))
  ).catch(() => []);
  return { url, title, elems };
}

async function aiDecide(
  page:    Page,
  context: string,
  history: string[],
  apiKey:  string,
): Promise<{ type: string; selector?: string; value?: string; url?: string; description: string }> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const state  = await getPageState(page);

  const res = await client.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 200,
    messages: [{
      role: 'system',
      content: `You are an automated app tester. Explore the app: create content, check settings, navigate features. One action at a time.
Respond with JSON: { "type": "click"|"fill"|"navigate"|"observe"|"wait", "selector"?: "css", "value"?: "text", "url"?: "url", "description": "what you're doing" }`,
    }, {
      role: 'user',
      content: `Page: ${state.url}\nTitle: ${state.title}\nContext: ${context}\nLast 5 actions: ${history.slice(-5).join(' | ')}\nVisible elements: ${JSON.stringify(state.elems)}`,
    }],
  });

  const raw = res.choices[0].message.content || '{}';
  return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{"type":"wait","description":"fallback wait"}');
}

function heuristic(i: number) {
  // Simple round-robin heuristic when no API key
  const actions = [
    { type: 'observe',  description: 'Observe current state' },
    { type: 'click',    selector: 'a[href]:not([href="#"])', description: 'Click first nav link' },
    { type: 'wait',     description: 'Wait' },
    { type: 'click',    selector: 'button:not([disabled])', description: 'Click first button' },
  ];
  return actions[i % actions.length];
}

async function execute(page: Page, action: any, session: ExplorerSession): Promise<boolean> {
  try {
    switch (action.type) {
      case 'click':
        if (action.selector) {
          const el = page.locator(action.selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) await el.click({ timeout: 4000 });
        }
        break;
      case 'fill':
        if (action.selector && action.value !== undefined)
          await page.locator(action.selector).first().fill(action.value, { timeout: 4000 });
        break;
      case 'navigate':
        if (action.url) await page.goto(action.url, { timeout: 10_000 });
        break;
      case 'wait':
        await page.waitForTimeout(2000);
        break;
      case 'observe':
        session.observations.push(`${page.url()} — ${await page.title().catch(() => '')}`);
        break;
    }
    return true;
  } catch (e: any) {
    session.errors.push(`${action.description}: ${e.message?.split('\n')[0]}`);
    return false;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function exploreApp(
  page:         Page,
  authMethod:   string,
  durationMs:   number,
  onScreenshot: (label: string) => Promise<void>,
): Promise<ExploreResult> {
  const session: ExplorerSession = { actions: [], observations: [], errors: [] };
  const history: string[] = [];
  const apiKey  = process.env.OPENAI_API_KEY;
  const start   = Date.now();
  const end     = start + durationMs;
  let   i       = 0;

  const context = `New user authenticated via: ${authMethod}. Explore features: create content, check settings, navigate sections.`;

  while (Date.now() < end) {
    i++;
    let action: any;

    if (apiKey) {
      try   { action = await aiDecide(page, context, history, apiKey); }
      catch { action = heuristic(i); }
    } else {
      action = heuristic(i);
    }

    const ok = await execute(page, action, session);
    session.actions.push({ type: action.type, description: action.description, ok });
    history.push(`${action.type}: ${action.description} (${ok ? 'ok' : 'fail'})`);

    // Screenshot every ~30 s
    if (i % 10 === 0) {
      await onScreenshot(`explore-${i}`).catch(() => {});
    }

    await page.waitForTimeout(400);
  }

  return {
    actionsCount:      session.actions.length,
    observationsCount: session.observations.length,
    errorsCount:       session.errors.length,
    errors:            session.errors,
    durationMs:        Date.now() - start,
    session,
  };
}
