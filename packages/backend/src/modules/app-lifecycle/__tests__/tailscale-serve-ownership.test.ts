import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TailscaleServeOwnership } from '../tailscale-serve-ownership';

/**
 * The record decides which Tailscale Serve listeners the Hub may remove, so every way of failing to
 * read it has to end in owning nothing rather than in owning someone else's listener.
 */
describe('TailscaleServeOwnership', () => {
  const filePath = '/data/state/tailscale-serve-ownership.test.json';
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('keeps what the Hub published across processes, and drops what it released', async () => {
    const first = await new TailscaleServeOwnership(filePath).load();
    first.record(3001, 'http://172.18.0.10:3001');
    first.record(443, 'http://localhost:5002');
    first.release(443);
    await first.save();

    const second = await new TailscaleServeOwnership(filePath).load();
    expect(second.targetFor(3001)).toBe('http://172.18.0.10:3001');
    expect(second.targetFor(443)).toBeUndefined();
  });

  it('owns nothing and stays quiet when no record exists yet', async () => {
    const ownership = await new TailscaleServeOwnership('/data/state/never-written.json').load();

    expect(ownership.targetFor(3001)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('owns nothing and warns when the record cannot be parsed', async () => {
    // What a crash or a full disk leaves behind, since the write is not atomic.
    await fs.promises.writeFile(filePath, '{"ports": {"3001": "http://172.18.0.10:300', 'utf-8');

    const ownership = await new TailscaleServeOwnership(filePath).load();

    expect(ownership.targetFor(3001)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cannot parse'));
  });

  it('ignores entries that are not a port and a target', async () => {
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ ports: { '3001': 'http://172.18.0.10:3001', '0': 'http://x', '70000': 'http://x', notaport: 'http://x', '3002': '' } }),
      'utf-8',
    );

    const ownership = await new TailscaleServeOwnership(filePath).load();

    expect(ownership.targetFor(3001)).toBe('http://172.18.0.10:3001');
    for (const port of [0, 70_000, 3002]) {
      expect(ownership.targetFor(port)).toBeUndefined();
    }
  });

  it('keeps the record pending when the write fails, so the next save retries it', async () => {
    // A file where the directory should be: mkdir fails, as an unwritable /data would.
    const blocked = path.join('/data/state/blocked', 'ownership.json');
    await fs.promises.writeFile('/data/state/blocked', 'not a directory', 'utf-8');

    const ownership = await new TailscaleServeOwnership(blocked).load();
    ownership.record(3001, 'http://172.18.0.10:3001');
    await expect(ownership.save()).rejects.toThrow();

    await fs.promises.unlink('/data/state/blocked');
    await ownership.save();

    expect(await new TailscaleServeOwnership(blocked).load().then((saved) => saved.targetFor(3001))).toBe('http://172.18.0.10:3001');
  });
});
