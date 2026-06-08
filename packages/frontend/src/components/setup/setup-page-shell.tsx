import { getLogo } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';
import i18next from 'i18next';
import type { ReactNode } from 'react';

interface SetupPageShellProps {
  children: ReactNode;
  /** Step indicator row (e.g. StepTriggerList) */
  steps?: ReactNode;
  title?: string;
  showLogo?: boolean;
  className?: string;
  contentClassName?: string;
}

export function SetupPageShell({ children, steps, title, showLogo = true, className, contentClassName }: SetupPageShellProps) {
  const resolvedTitle = title ?? i18next.t('HUB_STATUS_SETUP_YOUR_HUB');

  return (
    <div
      className={cn('flex flex-col items-center overflow-y-auto bg-background px-4 py-8', className)}
      style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}
    >
      <div className={cn('w-full max-w-3xl flex flex-col gap-6 my-auto', contentClassName)}>
        {(showLogo || title) && (
          <div className="text-center">
            {showLogo && (
              <img
                alt="Companion Hub logo"
                src={getLogo(true)}
                height={64}
                width={64}
                className="mx-auto mb-3 opacity-90"
                style={{ maxWidth: '100%', height: 'auto' }}
              />
            )}
            {resolvedTitle && <h1 className="text-2xl font-bold text-foreground">{resolvedTitle}</h1>}
          </div>
        )}

        {steps && <nav aria-label={i18next.t('SETUP_PROGRESS')}>{steps}</nav>}

        {children}
      </div>
    </div>
  );
}
