import type { DataProgress, DataProgressStep } from '@ci-hub/common/schemas';
import { humanBytes } from '@/components/ui/dense/dense';

const DATA_STEP_LABEL_KEYS: Record<DataProgressStep, string> = {
  copying_data: 'APP_DATA_STEP_COPYING_DATA',
  including_volumes: 'APP_DATA_STEP_INCLUDING_VOLUMES',
  archiving: 'APP_DATA_STEP_ARCHIVING',
  saving_backup: 'APP_DATA_STEP_SAVING_BACKUP',
  checking_backup: 'APP_DATA_STEP_CHECKING_BACKUP',
  unpacking_backup: 'APP_DATA_STEP_UNPACKING_BACKUP',
  removing_data: 'APP_DATA_STEP_REMOVING_DATA',
  restoring_data: 'APP_DATA_STEP_RESTORING_DATA',
  restoring_volumes: 'APP_DATA_STEP_RESTORING_VOLUMES',
};

/** How full the bar is, or `null` for a step with no total to measure against. */
export const dataProgressPercent = ({ doneBytes, totalBytes }: DataProgress): number | null =>
  doneBytes !== undefined && totalBytes ? Math.round((doneBytes / totalBytes) * 100) : null;

/** The step and its figures, e.g. `Backing up: 9.8 GB / 21 GB (45 MB/s)`. A step that cannot be measured is only named. */
export const dataProgressText = (t: (key: string) => string, { step, doneBytes, totalBytes, bytesPerSecond }: DataProgress): string => {
  const label = t(DATA_STEP_LABEL_KEYS[step]);

  if (doneBytes === undefined) return label;

  const amount = totalBytes === undefined ? humanBytes(doneBytes) : `${humanBytes(doneBytes)} / ${humanBytes(totalBytes)}`;

  return bytesPerSecond ? `${label}: ${amount} (${humanBytes(bytesPerSecond)}/s)` : `${label}: ${amount}`;
};
