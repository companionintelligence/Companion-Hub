import {
  getInstalledAppsQueryKey,
  restartAllAppsMutation,
  startAllAppsMutation,
  stopAllAppsMutation,
  updateAllAppsMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, ListChecks, Play, RotateCw, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

type BatchAction = 'start' | 'stop' | 'restart' | 'update';

interface BatchActionsMenuProps {
  /** Apps that are running right now: what "Stop all" and "Restart all" would act on. */
  runningCount: number;
  /** Apps that are stopped right now: what "Start all" would act on. */
  stoppedCount: number;
  /** Apps with a newer version available. "Update all" is only offered when there are some. */
  updatesAvailable: number;
}

/**
 * Start, stop, restart or update every app in one go.
 *
 * The Hub has had these routes (and the matching MCP tools) all along; the UI could only reach them
 * through the developer panel. Each action asks first, since stopping or restarting everything is
 * not something to do by a stray click, and an action with nothing to act on is disabled rather than
 * left to run an empty sweep.
 */
export const BatchActionsMenu = ({ runningCount, stoppedCount, updatesAvailable }: BatchActionsMenuProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<BatchAction | null>(null);

  const onSuccess = (inProgress: string) => () => {
    toast.info(t(inProgress));
    setConfirming(null);
    // The per-app status changes arrive over SSE, but a sweep that touches many apps can outrun them.
    void queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
  };
  const onError = (error: TranslatableError) => {
    toast.error(t(error.message, error.intlParams));
    setConfirming(null);
  };

  const start = useMutation({ ...startAllAppsMutation(), onSuccess: onSuccess('MY_APPS_START_ALL_IN_PROGRESS'), onError });
  const stop = useMutation({ ...stopAllAppsMutation(), onSuccess: onSuccess('MY_APPS_STOP_ALL_IN_PROGRESS'), onError });
  const restart = useMutation({ ...restartAllAppsMutation(), onSuccess: onSuccess('MY_APPS_RESTART_ALL_IN_PROGRESS'), onError });
  const update = useMutation({ ...updateAllAppsMutation(), onSuccess: onSuccess('MY_APPS_UPDATE_ALL_IN_PROGRESS'), onError });

  const actions: Record<
    BatchAction,
    {
      title: string;
      subtitles: string[];
      submit: string;
      intent: 'primary' | 'danger';
      mutation: { mutate: (variables: Record<string, never>) => void; isPending: boolean };
    }
  > = {
    start: {
      title: 'MY_APPS_START_ALL_FORM_TITLE',
      subtitles: ['MY_APPS_START_ALL_FORM_SUBTITLE'],
      submit: 'MY_APPS_START_ALL_FORM_SUBMIT',
      intent: 'primary',
      mutation: start,
    },
    stop: {
      title: 'MY_APPS_STOP_ALL_FORM_TITLE',
      subtitles: ['MY_APPS_STOP_ALL_FORM_SUBTITLE'],
      submit: 'MY_APPS_STOP_ALL_FORM_SUBMIT',
      intent: 'danger',
      mutation: stop,
    },
    restart: {
      title: 'MY_APPS_RESTART_ALL_FORM_TITLE',
      subtitles: ['MY_APPS_RESTART_ALL_FORM_SUBTITLE'],
      submit: 'MY_APPS_RESTART_ALL_FORM_SUBMIT',
      intent: 'danger',
      mutation: restart,
    },
    update: {
      title: 'MY_APPS_UPDATE_ALL_FORM_TITLE',
      subtitles: ['MY_APPS_UPDATE_ALL_FORM_SUBTITLE_1', 'MY_APPS_UPDATE_ALL_FORM_SUBTITLE_2'],
      submit: 'MY_APPS_UPDATE_ALL_FORM_SUBMIT',
      intent: 'primary',
      mutation: update,
    },
  };

  const active = confirming ? actions[confirming] : null;

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" data-testid="batch-actions-trigger">
            <ListChecks className="mr-2 size-4" aria-hidden="true" />
            {t('MY_APPS_BATCH_ACTIONS')}
            <ChevronDown className="ml-1 size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem disabled={stoppedCount === 0} onSelect={() => setConfirming('start')}>
            <Play className="mr-2 size-4" aria-hidden="true" />
            {t('MY_APPS_START_ALL_FORM_SUBMIT')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={runningCount === 0} onSelect={() => setConfirming('stop')}>
            <Square className="mr-2 size-4" aria-hidden="true" />
            {t('MY_APPS_STOP_ALL_FORM_SUBMIT')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={runningCount === 0} onSelect={() => setConfirming('restart')}>
            <RotateCw className="mr-2 size-4" aria-hidden="true" />
            {t('MY_APPS_RESTART_ALL_FORM_SUBMIT')}
          </DropdownMenuItem>
          {updatesAvailable > 0 && (
            <DropdownMenuItem onSelect={() => setConfirming('update')}>
              <Download className="mr-2 size-4" aria-hidden="true" />
              {t('MY_APPS_UPDATE_ALL_FORM_SUBMIT')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={active !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        {active && (
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t(active.title)}</DialogTitle>
            </DialogHeader>
            <DialogDescription className="space-y-2 py-2">
              {active.subtitles.map((subtitle) => (
                <span key={subtitle} className="block">
                  {t(subtitle)}
                </span>
              ))}
            </DialogDescription>
            <DialogFooter>
              <Button intent={active.intent} loading={active.mutation.isPending} onClick={() => active.mutation.mutate({})}>
                {t(active.submit)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};
