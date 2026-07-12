import { describe, expect, it } from 'vitest';
import { isDiskUsageAboveThreshold, shouldShowCoreServerBanner } from './core-server-banner-visibility';

describe('core-server-banner visibility', () => {
  describe('isDiskUsageAboveThreshold', () => {
    it('shows when usage is strictly above 90%', () => {
      expect(isDiskUsageAboveThreshold({ diskUsed: 91, diskSize: 100 })).toBe(true);
      expect(isDiskUsageAboveThreshold({ diskUsed: 901, diskSize: 1000 })).toBe(true);
    });

    it('hides at exactly 90% or below', () => {
      expect(isDiskUsageAboveThreshold({ diskUsed: 90, diskSize: 100 })).toBe(false);
      expect(isDiskUsageAboveThreshold({ diskUsed: 900, diskSize: 1000 })).toBe(false);
      expect(isDiskUsageAboveThreshold({ diskUsed: 50, diskSize: 100 })).toBe(false);
    });

    it('hides when disk size is zero or negative', () => {
      expect(isDiskUsageAboveThreshold({ diskUsed: 91, diskSize: 0 })).toBe(false);
      expect(isDiskUsageAboveThreshold({ diskUsed: 91, diskSize: -1 })).toBe(false);
    });
  });

  describe('shouldShowCoreServerBanner', () => {
    it('shows when disk usage is above threshold', () => {
      expect(
        shouldShowCoreServerBanner({
          system: { diskUsed: 91, diskSize: 100 },
        }),
      ).toBe(true);
    });

    it('hides when disk usage is at or below threshold', () => {
      expect(
        shouldShowCoreServerBanner({
          system: { diskUsed: 90, diskSize: 100 },
        }),
      ).toBe(false);
    });

    it('waits for system metrics before showing', () => {
      expect(shouldShowCoreServerBanner({ system: undefined })).toBe(false);
    });
  });
});
