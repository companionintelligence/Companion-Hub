import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CORE_SERVER_LOW_CPU_CORES, CORE_SERVER_LOW_DISK_GB, CORE_SERVER_LOW_RAM_GB } from './core-server-banner-visibility';

const CORE_SERVER_URL = 'https://www.ci.computer/store/p/core';

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
    if (system.memoryTotal < CORE_SERVER_LOW_RAM_GB) {
      return { titleKey: 'CORE_SERVER_BANNER_LOW_RAM_TITLE', messageKey: 'CORE_SERVER_BANNER_LOW_RAM_MESSAGE' };
    }
    if (system.diskSize < CORE_SERVER_LOW_DISK_GB) {
      return { titleKey: 'CORE_SERVER_BANNER_LOW_DISK_TITLE', messageKey: 'CORE_SERVER_BANNER_LOW_DISK_MESSAGE' };
    }
    if (system.cpuCores <= CORE_SERVER_LOW_CPU_CORES) {
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
      className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/[0.08] px-4 py-3 text-sm shadow-sm md:flex-row md:items-center md:justify-between"
    >
      <span className="leading-relaxed text-foreground">
        <strong className="font-semibold text-primary">{t(titleKey)}</strong> <span className="text-muted-foreground">— {t(messageKey)}</span>
      </span>
      <div className="flex shrink-0 items-center gap-2 self-start md:self-auto">
        <a
          href={CORE_SERVER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('CORE_SERVER_BANNER_LEARN_MORE')}
        </a>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('CORE_SERVER_BANNER_DISMISS')}
          className="rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
