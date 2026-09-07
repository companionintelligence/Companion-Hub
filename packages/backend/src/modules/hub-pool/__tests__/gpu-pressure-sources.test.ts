import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_PRESSURE_FILE_MAX_AGE_MS, occupancyFromHostPressureFile, readAmdDrmOccupancy, type HostPressureFile } from '../gpu-pressure-sources';

describe('gpu pressure sources', () => {
  describe('readAmdDrmOccupancy', () => {
    let sysfsRoot: string;

    beforeEach(async () => {
      // The backend suite runs against a memfs mock of `fs` (src/tests/vite.setup.ts), so this is an
      // in-memory tree, not a real one — which is exactly what a sysfs layout test wants.
      sysfsRoot = '/data/state/test-drm';
      await fs.promises.mkdir(sysfsRoot, { recursive: true });
    });

    afterEach(async () => {
      await fs.promises.rm(sysfsRoot, { recursive: true, force: true });
    });

    /** Lay out one `cardN` the way the amdgpu driver does: the counter lives under `device/`. */
    async function writeCard(name: string, busyPercent: string | null): Promise<void> {
      const deviceDir = path.join(sysfsRoot, 'class', 'drm', name, 'device');
      await fs.promises.mkdir(deviceDir, { recursive: true });
      if (busyPercent !== null) {
        await fs.promises.writeFile(path.join(deviceDir, 'gpu_busy_percent'), busyPercent);
      }
    }

    it('reads the busiest card as a fraction', async () => {
      await writeCard('card0', '42\n');

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeCloseTo(0.42);
    });

    it('takes the MAX across cards, never the first and never the mean', async () => {
      await writeCard('card0', '10\n');
      await writeCard('card1', '90\n');

      // One saturated card is a saturated node for the next request; averaging would let the idle
      // one hide it, and taking the first would make the answer depend on readdir order.
      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeCloseTo(0.9);
    });

    it('skips entries that are not cardN', async () => {
      // renderD128 is a render node, card0-DP-1 is a connector: neither has a device/ counter, and
      // treating them as cards would mean walking the whole tree on every sample.
      await writeCard('renderD128', '99\n');
      await writeCard('card0-DP-1', '99\n');
      await writeCard('card0', '20\n');

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeCloseTo(0.2);
    });

    it('returns null when the sysfs mount is absent, rather than 0', async () => {
      // This is the shipped state on every node: nothing mounts /sys yet. It MUST read as
      // unmeasured, because unmeasured ranks neutral while 0 would rank the node as idle.
      const missing = await readAmdDrmOccupancy(path.join(sysfsRoot, 'nope'));

      expect(missing).toBeNull();
      expect(missing).not.toBe(0);
    });

    it('returns null when a card exposes no gpu_busy_percent (an NVIDIA or Intel card)', async () => {
      await writeCard('card0', null);

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeNull();
    });

    it('ignores a non-numeric or out-of-range counter instead of reading it as 0', async () => {
      await writeCard('card0', 'N/A\n');
      await writeCard('card1', '-1\n');
      await writeCard('card2', '900\n');

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeNull();
    });

    it('still reports the readable card when a sibling is unreadable', async () => {
      await writeCard('card0', 'garbage');
      await writeCard('card1', '55');

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBeCloseTo(0.55);
    });

    it('reports a genuinely idle card as 0, which is a measurement and not an absence', async () => {
      await writeCard('card0', '0\n');

      await expect(readAmdDrmOccupancy(sysfsRoot)).resolves.toBe(0);
    });
  });

  describe('occupancyFromHostPressureFile', () => {
    const now = Date.parse('2026-09-07T12:00:00.000Z');

    function file(overrides: Partial<HostPressureFile> = {}): HostPressureFile {
      return { schemaVersion: 1, sampledAt: new Date(now).toISOString(), busyPercent: 50, ...overrides };
    }

    it('converts busyPercent to a fraction', () => {
      expect(occupancyFromHostPressureFile(file({ busyPercent: 75 }), now)).toBeCloseTo(0.75);
    });

    it('ignores a file claiming a schemaVersion this build does not understand', () => {
      // A writer that redefined busyPercent must not have an older reader keep believing it.
      expect(occupancyFromHostPressureFile(file({ schemaVersion: 2 }), now)).toBeNull();
    });

    it('ignores a stale file rather than reading it as idle', () => {
      const stale = file({ sampledAt: new Date(now - HOST_PRESSURE_FILE_MAX_AGE_MS - 1).toISOString(), busyPercent: 0 });

      // A writer that died with the card at 100% would otherwise leave a permanent
      // "this node is free" advertisement behind it.
      expect(occupancyFromHostPressureFile(stale, now)).toBeNull();
    });

    it('ignores a file stamped far in the future', () => {
      const ahead = file({ sampledAt: new Date(now + HOST_PRESSURE_FILE_MAX_AGE_MS + 1).toISOString() });

      expect(occupancyFromHostPressureFile(ahead, now)).toBeNull();
    });

    it('ignores an unparseable timestamp', () => {
      expect(occupancyFromHostPressureFile(file({ sampledAt: 'yesterday' }), now)).toBeNull();
    });

    it.each([-5, 101, Number.NaN, Number.POSITIVE_INFINITY])('ignores an out-of-range busyPercent (%s)', (busyPercent) => {
      expect(occupancyFromHostPressureFile(file({ busyPercent }), now)).toBeNull();
    });
  });
});
