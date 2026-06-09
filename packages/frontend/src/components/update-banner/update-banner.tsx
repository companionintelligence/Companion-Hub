import type { UpdateInfo } from '../../hooks/use-update-checker';
import { useTranslation } from 'react-i18next';

interface UpdateBannerProps {
  update: UpdateInfo;
  onDismiss: () => void;
}

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation();

  const handleDownload = async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(update.downloadUrl);
    } catch {
      // Fall back to window.open if the plugin call fails
      window.open(update.downloadUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40"
    >
      <span className="text-amber-900 dark:text-amber-200">
        <strong>
          {t('APP_NAME')} {update.latestVersion}
        </strong>{' '}
        {t('UPDATE_BANNER_AVAILABLE_PRESERVED')}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void handleDownload()}
          className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
        >
          {t('UPDATE_BANNER_DOWNLOAD_UPDATE')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('UPDATE_BANNER_DISMISS_NOTIFICATION')}
          className="rounded-md px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
        >
          {t('COMMON_LATER')}
        </button>
      </div>
    </div>
  );
}
