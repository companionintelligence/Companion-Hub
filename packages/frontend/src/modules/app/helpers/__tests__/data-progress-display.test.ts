import { describe, expect, it } from 'vitest';
import { humanBytes } from '@/components/ui/dense/dense';
import { dataProgressPercent, dataProgressText } from '../data-progress-display';

const t = (key: string) => key;

describe('dataProgressText', () => {
  it('gives the figures, the total and the speed', () => {
    expect(dataProgressText(t, { step: 'archiving', doneBytes: 9_800_000_000, totalBytes: 21_000_000_000, bytesPerSecond: 45_000_000 })).toBe(
      `APP_DATA_STEP_ARCHIVING: ${humanBytes(9_800_000_000)} / ${humanBytes(21_000_000_000)}, ${humanBytes(45_000_000)}/s`,
    );
  });

  it('gives a running figure alone before the total is known', () => {
    expect(dataProgressText(t, { step: 'checking_backup', doneBytes: 1024 })).toBe(`APP_DATA_STEP_CHECKING_BACKUP: ${humanBytes(1024)}`);
  });

  it('only names a step it cannot measure', () => {
    expect(dataProgressText(t, { step: 'removing_data' })).toBe('APP_DATA_STEP_REMOVING_DATA');
  });

  it('leaves the speed out until there is one', () => {
    expect(dataProgressText(t, { step: 'saving_backup', doneBytes: 1, totalBytes: 2, bytesPerSecond: 0 })).toBe(
      `APP_DATA_STEP_SAVING_BACKUP: ${humanBytes(1)} / ${humanBytes(2)}`,
    );
  });
});

describe('dataProgressPercent', () => {
  it('fills the bar to match', () => {
    expect(dataProgressPercent({ step: 'archiving', doneBytes: 9_800_000_000, totalBytes: 21_000_000_000 })).toBe(47);
  });

  it.each([
    ['no total', { step: 'checking_backup', doneBytes: 5 }],
    ['nothing measured', { step: 'removing_data' }],
    ['a total of nothing', { step: 'archiving', doneBytes: 0, totalBytes: 0 }],
  ] as const)('has no figure with %s', (_name, progress) => {
    expect(dataProgressPercent(progress)).toBeNull();
  });
});
