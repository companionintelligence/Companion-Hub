import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real files: the point is what lands in app.log.
vi.unmock('node:fs');
vi.unmock('fs');

const { LoggerService } = await import('./logger.service');
const realFs = (await import('node:fs')).default;

describe('LoggerService', () => {
  let folder: string;
  let logger: InstanceType<typeof LoggerService>;

  const readLog = async () => {
    // winston writes asynchronously; give the file transport a moment to flush.
    for (let i = 0; i < 40; i++) {
      const text = realFs.existsSync(path.join(folder, 'app.log')) ? realFs.readFileSync(path.join(folder, 'app.log'), 'utf8') : '';
      if (text.trim()) return text;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return '';
  };

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-'));
    logger = new LoggerService('test', folder, 'debug');
  });

  afterEach(() => {
    realFs.rmSync(folder, { recursive: true, force: true });
  });

  it('writes a plain message untouched', async () => {
    logger.info('Backup completed!');

    expect(await readLog()).toContain('Backup completed!');
  });

  it('does not write credentials from a logged request body or header object', async () => {
    logger.debug('HTTP request', 'POST', '/api/auth/login', {
      username: 'op@example.com',
      password: 'hunter2',
      headers: { cookie: 'ci-hub-sid=abc', accept: 'json' },
    });

    const text = await readLog();
    expect(text).toContain('/api/auth/login');
    expect(text).toContain('op@example.com');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ci-hub-sid=abc');
  });

  it('does not write the Authorization header an HTTP client error carries', async () => {
    const error = Object.assign(new Error('Request failed with status code 502'), {
      toJSON: () => ({ message: 'Request failed', config: { headers: { Authorization: 'Bearer live-secret' } } }),
    });

    logger.error('portal call failed', { error });

    const text = await readLog();
    expect(text).toContain('Request failed');
    expect(text).not.toContain('live-secret');
  });

  it('masks a credential inside a logged string and inside an Error message', async () => {
    logger.warn('callback http://hub.test/cb?token=abc123 rejected');
    logger.error(new Error('bad header Bearer eyJ.abc.def'));

    const text = await readLog();
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('eyJ.abc.def');
  });
});
