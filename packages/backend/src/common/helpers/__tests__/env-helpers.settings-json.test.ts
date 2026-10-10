import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '@/common/constants';
import { slowDisk } from '@/tests/utils/slow-disk';
import { generateSystemEnvFile, writeSettingsJsonFile } from '../env-helpers';

// On the suite's memfs disk. The writes that overlap are held between their open and their bytes by
// `slowDisk`, which is the window two real writes can both truncate the file in.

const STATE_DIR = path.join(DATA_DIR, 'state');
const SETTINGS_PATH = path.join(STATE_DIR, 'settings.json');

/** A settings save writes the whole file, pretty-printed. */
const asWritten = (settings: Record<string, unknown>) => JSON.stringify(settings, null, 2);

const settingsFiles = () => fs.readdirSync(STATE_DIR).filter((name) => name.startsWith('settings.json'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeSettingsJsonFile', () => {
  it('leaves one whole file when two writes overlap, never the shorter one over the end of the longer', async () => {
    fs.writeFileSync(SETTINGS_PATH, '{}');
    const longer = asWritten({
      ciHubApiKey: 'portal-device-key',
      inferenceModel: 'nemotron-3-nano:30b',
      inferenceEmbeddingModel: 'nomic-embed-text',
    });
    const shorter = asWritten({ ciHubApiKey: 'portal-device-key' });
    // Held alike, so the longer write, started first, also lands first.
    slowDisk(() => 5);

    await Promise.all([writeSettingsJsonFile(SETTINGS_PATH, longer), writeSettingsJsonFile(SETTINGS_PATH, shorter)]);

    expect([longer, shorter]).toContain(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    expect(settingsFiles()).toEqual(['settings.json']);
  });

  it('leaves the previous file as it was when a write fails part way', async () => {
    const previous = asWritten({ ciHubApiKey: 'portal-device-key' });
    fs.writeFileSync(SETTINGS_PATH, previous);
    // The disk fills up after the open, which has already truncated whatever it opened.
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file) => {
      await (await fs.promises.open(String(file), 'w')).close();
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });

    await expect(writeSettingsJsonFile(SETTINGS_PATH, asWritten({ ciHubApiKey: 'portal-device-key', guestDashboard: true }))).rejects.toThrow(
      'ENOSPC',
    );

    expect(fs.readFileSync(SETTINGS_PATH, 'utf8')).toBe(previous);
    expect(settingsFiles()).toEqual(['settings.json']);
  });
});

describe('generateSystemEnvFile with a settings.json that does not parse', () => {
  const envBefore = { ...process.env };

  beforeEach(() => {
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
  });

  afterEach(() => {
    // The boot copies what it resolved into process.env.
    for (const key of Object.keys(process.env)) {
      if (!(key in envBefore)) delete process.env[key];
    }
    Object.assign(process.env, envBefore);
  });

  const keptCopies = () => settingsFiles().filter((name) => name.startsWith('settings.json.corrupt-'));

  it('boots on the complete object a torn write left at the start of the file, and keeps the whole file beside it', async () => {
    const lastWrite = asWritten({ ciHubApiKey: 'portal-device-key', portalDomain: 'ci0.pw', guestDashboard: true });
    // What two overlapping saves left on a Windows 11 Hub: the shorter write, then the end of the longer one.
    const torn = `${lastWrite}  "inferenceModel": "nemotron-3-nano:30b",\n  "inferenceEmbeddingModel": "nomic-embed-text"\n}`;
    fs.writeFileSync(SETTINGS_PATH, torn);

    const env = await generateSystemEnvFile();

    // Still paired, on the zone Portal assigned, with the rest of the last save applied.
    expect(env.get('DOMAIN')).toBe('ci0.pw');
    expect(env.get('GUEST_DASHBOARD')).toBe('true');
    expect(fs.readFileSync(SETTINGS_PATH, 'utf8')).toBe(lastWrite);
    expect(keptCopies()).toHaveLength(1);
    expect(fs.readFileSync(path.join(STATE_DIR, keptCopies()[0]), 'utf8')).toBe(torn);
  });

  it('boots on an empty settings.json when the file holds no complete object, and keeps the file beside it', async () => {
    const cutOff = '{\n  "ciHubApiKey": "portal-dev';
    fs.writeFileSync(SETTINGS_PATH, cutOff);

    await expect(generateSystemEnvFile()).resolves.toBeInstanceOf(Map);

    expect(fs.readFileSync(SETTINGS_PATH, 'utf8')).toBe('{}');
    expect(keptCopies()).toHaveLength(1);
    expect(fs.readFileSync(path.join(STATE_DIR, keptCopies()[0]), 'utf8')).toBe(cutOff);
  });
});
