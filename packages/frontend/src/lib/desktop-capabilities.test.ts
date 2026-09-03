import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Desktop Tauri ACL pin. After bootstrap the webview navigates to the Hub UI;
 * if that origin is missing from remote.urls, invoke('start_hub_command')
 * fails with "Command start_hub_command not allowed by ACL".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib -> frontend -> packages -> packages/desktop/src-tauri
const CAPABILITIES = path.resolve(here, '../../../desktop/src-tauri/capabilities/default.json');

function loadRemoteUrls(): string[] {
  const parsed = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as {
    remote?: { urls?: string[] };
  };
  return parsed.remote?.urls ?? [];
}

describe('desktop Tauri remote URL allowlist', () => {
  it('allows loopback, local HTTPS, and hub.ci.localhost without a bare host wildcard', () => {
    const urls = loadRemoteUrls();

    expect(urls).toEqual(
      expect.arrayContaining([
        '*://localhost:*',
        '*://127.0.0.1:*',
        '*://*.localhost',
        '*://*.localhost:*',
        '*://*.ci.localhost',
        '*://*.ci.localhost:*',
        '*://ci.lan',
        '*://ci.lan:*',
        '*://*.ci.lan',
        '*://*.ci.lan:*',
        'https://*.ci.computer',
        'https://*.companionintelligence.com',
      ]),
    );

    for (const url of urls) {
      expect(url).not.toMatch(/^\*?:\/\/\*\/?\*?$/);
      expect(url).not.toBe('*://*:*');
      expect(url).not.toBe('https://*:*');
      expect(url).not.toBe('http://*:*');
    }
  });

  it('keeps local bootstrap (tauri://) on the allowlist for Retry Start', () => {
    const parsed = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as { local?: boolean };
    expect(parsed.local).toBe(true);
  });
});
