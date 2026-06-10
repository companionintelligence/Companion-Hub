import { installAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { addOptimisticInstalledApp } from '@/modules/app/helpers/optimistic-installed-apps';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { TranslatableError } from '@/types/error.types';
import { RotateCw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'react-tooltip';

interface InstallRetryButtonProps {
  urn: string;
  name: string;
  slug: string;
  config?: Record<string, unknown>;
  size?: 'sm' | 'md';
  className?: string;
}

export const InstallRetryButton: React.FC<InstallRetryButtonProps> = ({ urn, name, slug, config, size = 'sm', className }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();
  const tooltipId = `retry-install-${urn.replace(':', '-')}`;

  const retryMutation = useMutation({
    ...installAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onMutate: () => {
      setOptimisticStatus('installing', urn);
      addOptimisticInstalledApp(queryClient, { urn, name, slug });
    },
  });

  const iconSize = size === 'md' ? 18 : 16;

  return (
    <>
      <Tooltip className="tooltip" anchorSelect={`#${tooltipId}`}>
        {t('APP_ACTION_RETRY_INSTALL')}
      </Tooltip>
      <button
        id={tooltipId}
        type="button"
        aria-label={t('APP_ACTION_RETRY_INSTALL')}
        data-testid={`retry-install-${slug}`}
        className={
          className ??
          'absolute inset-0 flex items-center justify-center rounded-xl bg-background/25 hover:bg-background/35 dark:bg-background/15 dark:hover:bg-background/25 transition-colors'
        }
        disabled={retryMutation.isPending}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          retryMutation.mutate({ path: { urn }, body: config ?? {} });
        }}
      >
        <RotateCw className={`text-amber-600 ${retryMutation.isPending ? 'animate-spin' : ''}`} size={iconSize} strokeWidth={2.5} />
      </button>
    </>
  );
};
