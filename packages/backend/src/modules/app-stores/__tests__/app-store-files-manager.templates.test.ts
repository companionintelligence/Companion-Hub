/**
 * `data/**\/*.template` files are rendered by swapping `{{KEY}}` for the app's env value. The values
 * include secrets the user typed (passwords, API keys), so they must land in the rendered file exactly
 * as typed. These tests render real files on disk and read them back.
 */
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStore } from '@/core/database/drizzle/types';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppStoreFilesManager } = await import('../app-store-files-manager');

const STORE = 'test-store';
const APP = 'demo-app';
const URN = `${APP}:${STORE}` as AppUrn;

describe('AppStoreFilesManager template rendering', () => {
  let scratch: string;
  let appDataRoot: string;
  let installedApp: string;
  let manager: InstanceType<typeof AppStoreFilesManager>;

  const write = async (file: string, content: string) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  };

  /**
   * Render `template` as `data/app.conf.template` with `env` and return what landed in `data/app.conf`.
   * `FilesystemService.writeTextFile` ends every file it writes with one EOL, which is not part of the
   * rendering, so it is checked and dropped here.
   */
  const render = async (template: string, env: Record<string, string>) => {
    await write(path.join(installedApp, 'data', 'app.conf.template'), template);
    await manager.copyDataDir(URN, new Map(Object.entries(env)));
    const written = await fs.promises.readFile(path.join(appDataRoot, STORE, APP, 'data', 'app.conf'), 'utf8');
    expect(written.endsWith(os.EOL)).toBe(true);
    return written.slice(0, -os.EOL.length);
  };

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'store-templates-'));
    const dataDir = path.join(scratch, 'data');
    appDataRoot = path.join(scratch, 'app-data');
    installedApp = path.join(dataDir, 'apps', STORE, APP);

    const logger = mock<LoggerService>();
    const config = mock<ConfigurationService>();
    const directories = { dataDir, appDataDir: appDataRoot, appDir: scratch };
    config.getConfig.mockReturnValue({ directories } as never);
    config.get.mockImplementation(((key: string) => (key === 'directories' ? directories : undefined)) as never);

    manager = new AppStoreFilesManager(config, new FilesystemService(logger), logger, { slug: STORE } as AppStore);
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('replaces every occurrence of a key and leaves unknown placeholders alone', async () => {
    const out = await render('user={{DB_USER}}\nagain={{DB_USER}}\nother={{NOT_SET}}\n', { DB_USER: 'alice' });

    expect(out).toBe('user=alice\nagain=alice\nother={{NOT_SET}}\n');
  });

  it('replaces a different key on each line', async () => {
    const out = await render('a={{ONE}}\nb={{TWO}}\n', { ONE: '1', TWO: '2' });

    expect(out).toBe('a=1\nb=2\n');
  });

  // Each of these is a `$` sequence that String.prototype.replace expands when the value is passed as the
  // replacement string: `$$` is one `$`, `$&` the matched `{{KEY}}`, `` $` `` and `$'` the text before and
  // after the match, `$1` the first capture group (literal `$1` when the pattern has none).
  it.each([
    ['a doubled dollar', 'pa$$word'],
    ['the matched-text token', 'a$&b'],
    ['a numbered group token', 'x$1y'],
    ['the text-before token', 'a$`b'],
    ['the text-after token', "a$'b"],
    ['every token at once', "$$ $& $1 $` $' $<name>"],
    ['a lone trailing dollar', 'secret$'],
  ])('writes a value containing %s exactly as typed', async (_label, value) => {
    const out = await render('password={{DB_PASSWORD}}\nsurrounding text\n', { DB_PASSWORD: value });

    expect(out).toBe(`password=${value}\nsurrounding text\n`);
  });

  it('writes a dollar value into every occurrence, not just the first', async () => {
    const out = await render('a={{TOKEN}}|b={{TOKEN}}|c={{TOKEN}}', { TOKEN: '$&$&' });

    expect(out).toBe('a=$&$&|b=$&$&|c=$&$&');
  });

  it('does not let one value that contains a dollar sequence disturb another key', async () => {
    const out = await render('user={{DB_USER}}\npass={{DB_PASSWORD}}\n', { DB_USER: 'alice', DB_PASSWORD: 'p$$w$&d' });

    expect(out).toBe('user=alice\npass=p$$w$&d\n');
  });

  it('writes other regex-significant characters in a value literally', async () => {
    const value = '^(a|b)+[c]*\\d{2}.?$';
    const out = await render('re={{PATTERN}}', { PATTERN: value });

    expect(out).toBe(`re=${value}`);
  });

  it('matches a key made of regex-significant characters only as the literal name', async () => {
    const out = await render('x={{A.B}} y={{AxB}} z={{A+B}}', { 'A.B': 'dot', 'A+B': 'plus' });

    expect(out).toBe('x=dot y={{AxB}} z=plus');
  });

  it('matches a key that would read as a regex quantifier between the braces', async () => {
    // Unescaped, `{{1,2}}` is `{` repeated one or two times followed by `}}`, which never matches the text.
    const out = await render('n={{1,2}}', { '1,2': 'two' });

    expect(out).toBe('n=two');
  });

  it('writes an empty value as an empty string', async () => {
    const out = await render('k=[{{EMPTY}}]', { EMPTY: '' });

    expect(out).toBe('k=[]');
  });
});
