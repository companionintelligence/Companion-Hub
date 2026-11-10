import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const REPO_ROOT = path.join(__dirname, '../../../..');
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

type Compose = { services: Record<string, { environment?: Record<string, unknown> }> };

/*
 * Every production Hub used to boot with the broker password `admin`, because the compose fell back
 * to it on both the broker and the Hub (Companion-Hub#884). The env file has to name one now, and
 * compose refuses to start without it.
 */
describe.each(COMPOSE_COPIES)('%s RabbitMQ password', (relativePath) => {
  const compose: Compose = YAML.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8'));
  const passwords = [
    ['broker', compose.services['ci-hub-queue'].environment?.RABBITMQ_DEFAULT_PASS],
    ['Hub', compose.services['ci-hub'].environment?.RABBITMQ_PASSWORD],
  ] as const;

  it.each(passwords)('is required from the env file on the %s, with no default', (_side, value) => {
    expect(value).toMatch(/^\$\{RABBITMQ_PASSWORD:\?.+\}$/);
    expect(String(value)).not.toContain(':-');
    expect(String(value)).not.toMatch(/\badmin\b/);
  });
});
