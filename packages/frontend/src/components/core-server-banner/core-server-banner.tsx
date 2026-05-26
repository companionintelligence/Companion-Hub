import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const CORE_SERVER_URL = 'https://www.ci.computer/core-server';

/** Thresholds for "low spec" detection */
const LOW_RAM_GB = 8;
const LOW_DISK_GB = 100;
const LOW_CPU_CORES = 2;

export interface SystemSnapshot {
  memoryTotal: number;
  diskSize: number;
  cpuCores: number;
}

interface CoreServerBannerProps {
  onDismiss: () => void;
  system?: SystemSnapshot;
}

function getMessageKeys(system?: SystemSnapshot): { titleKey: string; messageKey: string } {
  if (system) {
    if (system.memoryTotal < LOW_RAM_GB) {
      return { titleKey: 'CORE_SERVER_BANNER_LOW_RAM_TITLE', messageKey: 'CORE_SERVER_BANNER_LOW_RAM_MESSAGE' };
    }
    if (system.diskSize < LOW_DISK_GB) {
      return { titleKey: 'CORE_SERVER_BANNER_LOW_DISK_TITLE', messageKey: 'CORE_SERVER_BANNER_LOW_DISK_MESSAGE' };
    }
    if (system.cpuCores <= LOW_CPU_CORES) {
      return { titleKey: 'CORE_SERVER_BANNER_LOW_CPU_TITLE', messageKey: 'CORE_SERVER_BANNER_LOW_CPU_MESSAGE' };
    }
  }
  return { titleKey: 'CORE_SERVER_BANNER_DEFAULT_TITLE', messageKey: 'CORE_SERVER_BANNER_DEFAULT_MESSAGE' };
}

export function CoreServerBanner({ onDismiss, system }: CoreServerBannerProps) {
  const { t } = useTranslation();
  const { titleKey, messageKey } = getMessageKeys(system);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="core-server-banner"
      className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm shadow-sm md:flex-row md:items-center md:justify-between dark:border-blue-900/60 dark:bg-blue-950/40"
    >
      <span className="text-blue-900 leading-relaxed dark:text-blue-200">
        <strong>{t(titleKey)}</strong> — {t(messageKey)}
      </span>
      <div className="flex shrink-0 items-center gap-2 self-start md:self-auto">
        <a
          href={CORE_SERVER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
        >
          {t('CORE_SERVER_BANNER_LEARN_MORE')}
        </a>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('CORE_SERVER_BANNER_DISMISS')}
          className="rounded-md p-1 text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
