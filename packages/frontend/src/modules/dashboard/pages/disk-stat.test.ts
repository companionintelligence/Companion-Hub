import { describe, expect, it } from 'vitest';
import { diskStatCopy } from './disk-stat';

const t = ((key: string, values?: Record<string, unknown>) => {
  if (key === 'DASHBOARD_UNAVAILABLE') return 'Unavailable';
  if (key === 'DASHBOARD_GB_OF') return `${values?.used} / ${values?.total} GB`;
  return key;
}) as never;

describe('diskStatCopy', () => {
  it('shows the platform note when the VM reports no disk', () => {
    expect(diskStatCopy({ diskUsed: 0, diskSize: 0, percentUsed: 0, platformGuidance: 'Give Docker Desktop more disk.' }, t)).toEqual({
      metric: 'Unavailable',
      subtitle: 'Give Docker Desktop more disk.',
      progress: 0,
    });
  });

  it('shows used and total when the disk was read', () => {
    expect(diskStatCopy({ diskUsed: 12, diskSize: 40, percentUsed: 30 }, t)).toEqual({
      metric: '30%',
      subtitle: '12 / 40 GB',
      progress: 30,
    });
  });
});
