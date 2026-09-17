import { getLogo } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface SetupPageShellProps {
  children: ReactNode;
  /** Step indicator row (e.g. StepTriggerList) */
  steps?: ReactNode;
  title?: string;
  showLogo?: boolean;
  className?: string;
  contentClassName?: string;
  /**
   * Tighten the frame on short desktop windows and put the logo beside the title, the way the
   * desktop bootstrap page does, so a status card and its actions fit a 600px-tall window.
   */
  fitShortWindows?: boolean;
}

export function SetupPageShell({
  children,
  steps,
  title,
  showLogo = true,
  className,
  contentClassName,
  fitShortWindows = false,
}: SetupPageShellProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('COMMON_SET_UP_YOUR_HUB');

  return (
    <div
      className={cn(
        'flex flex-col items-center overflow-y-auto bg-background px-4 py-8',
        fitShortWindows && 'short-window:py-5 compact-window:py-4',
        className,
      )}
      style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}
    >
      <div
        className={cn(
          'w-full max-w-3xl flex flex-col gap-6 my-auto',
          fitShortWindows && 'tight-window:gap-4 compact-window:gap-3.5',
          contentClassName,
        )}
      >
        {(showLogo || title) && (
          <div
            className={cn(
              'text-center',
              fitShortWindows && 'compact-window:flex compact-window:items-center compact-window:justify-center compact-window:gap-2.5',
            )}
          >
            {showLogo && (
              <img
                alt="CI Hub logo"
                src={getLogo(true)}
                height={64}
                width={64}
                className={cn(
                  'mx-auto mb-3 opacity-90',
                  fitShortWindows && 'tight-window:mb-2 tight-window:w-[48px] compact-window:m-0 compact-window:w-[30px]',
                )}
                style={{ maxWidth: '100%', height: 'auto' }}
              />
            )}
            {resolvedTitle && (
              <h1 className={cn('text-2xl font-bold text-foreground', fitShortWindows && 'tight-window:text-xl compact-window:text-[19px]')}>
                {resolvedTitle}
              </h1>
            )}
          </div>
        )}

        {steps && <nav aria-label={t('SETUP_PROGRESS')}>{steps}</nav>}

        {children}
      </div>
    </div>
  );
}
