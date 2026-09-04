import { getAppComposeDiffOptions, getAppConfigDiffOptions, getAppOptions, updateAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, ChevronLeft, Loader2, X } from 'lucide-react';
import type { TranslatableError } from '@/types/error.types';
import { redirect, useLocation, useNavigate, useParams } from 'react-router';
import type { Route } from './+types/app-update-page';
import { getApp } from '@/api-client';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!params.appId || !params.storeId) {
    return redirect('/apps');
  }

  const appOptions = await getApp({ path: { urn: `${params.appId}:${params.storeId}` } });

  if (!appOptions.data) {
    return redirect('/apps');
  }

  return appOptions.data;
}

export default function AppUpdatePage({ loaderData }: Route.ComponentProps) {
  const params = useParams<{ storeId: string; appId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const storeId = params.storeId;
  const appId = params.appId;

  const { data: appData } = useQuery({
    ...getAppOptions({ path: { urn: `${appId}:${storeId}` } }),
    initialData: loaderData,
  });

  const { info, metadata } = appData;

  const [backupApp, setBackupApp] = useState(true);

  const configDiffQuery = useQuery({
    ...getAppConfigDiffOptions({ path: { urn: info.urn } }),
  });

  const composeDiffQuery = useQuery({
    ...getAppComposeDiffOptions({ path: { urn: info.urn } }),
  });

  const update = useMutation({
    ...updateAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onMutate: () => {
      navigate(location.state?.from || '/apps');
    },
  });

  const configChanged = useMemo(() => {
    if (!configDiffQuery.data) return undefined;
    return configDiffQuery.data.current !== configDiffQuery.data.new;
  }, [configDiffQuery.data]);

  const composeChanged = useMemo(() => {
    if (!composeDiffQuery.data) return undefined;
    return composeDiffQuery.data.current !== composeDiffQuery.data.new;
  }, [composeDiffQuery.data]);

  return (
    <Card data-testid="app-update">
      <CardHeader className="border-0 pb-0">
        <div className="flex flex-col lg:flex-row items-start lg:items-center border-b pb-4 w-full">
          <AppLogo urn={info.urn} size={96} alt={info.name} />
          <div className="mt-3 lg:mt-0 lg:ml-3">
            <h2 className="mb-1 text-2xl font-bold">{t('APP_UPDATE_FORM_TITLE', { name: info.name })}</h2>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <span className="badge bg-muted text-white">{info.version}</span>
              <ArrowRight size={16} />
              <span className="badge bg-success text-success-foreground">{metadata.latestDockerVersion}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="space-y-4" data-testid="update-summary">
            <div className="space-y-3">
              <div className="flex justify-between items-center" data-testid="update-summary-version">
                <span className="text-sm text-muted-foreground">{t('COMMON_VERSION')}</span>
                <span className="text-sm font-medium">
                  {info.version} <ArrowRight size={12} className="inline mx-1" /> {metadata.latestDockerVersion}
                </span>
              </div>
              {info.supported_architectures && info.supported_architectures.length > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">{t('COMMON_ARCHITECTURES')}</span>
                  <span className="text-sm font-medium">{info.supported_architectures.join(', ')}</span>
                </div>
              )}
              {metadata.minHubVersion && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">{t('COMMON_MIN_HUB_VERSION')}</span>
                  <span className="text-sm font-medium">{metadata.minHubVersion}</span>
                </div>
              )}
              <div className="border-t border-border/40 pt-2 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  {configChanged === undefined ? (
                    <Loader2 size={14} className="animate-spin text-muted-foreground" />
                  ) : configChanged ? (
                    <Check size={14} className="text-amber-500" />
                  ) : (
                    <X size={14} className="text-muted-foreground" />
                  )}
                  <span>
                    {configChanged === undefined
                      ? t('APP_UPDATE_SUMMARY_CONFIG_CHECKING')
                      : configChanged
                        ? t('APP_UPDATE_SUMMARY_CONFIG_CHANGED')
                        : t('APP_UPDATE_SUMMARY_CONFIG_UNCHANGED')}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {composeChanged === undefined ? (
                    <Loader2 size={14} className="animate-spin text-muted-foreground" />
                  ) : composeChanged ? (
                    <Check size={14} className="text-amber-500" />
                  ) : (
                    <X size={14} className="text-muted-foreground" />
                  )}
                  <span>
                    {composeChanged === undefined
                      ? t('APP_UPDATE_SUMMARY_COMPOSE_CHECKING')
                      : composeChanged
                        ? t('APP_UPDATE_SUMMARY_COMPOSE_CHANGED')
                        : t('APP_UPDATE_SUMMARY_COMPOSE_UNCHANGED')}
                  </span>
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="update-what-happens">
              {t('APP_UPDATE_WHAT_HAPPENS', { name: info.name })}
            </p>

            <div className="border-t border-border/40 pt-3">
              <p className="text-sm text-muted-foreground">{t('APP_UPDATE_BACKUP_SUBTITLE')}</p>
              <Switch
                checked={backupApp}
                onCheckedChange={setBackupApp}
                label={t('COMMON_BACKUP')}
                className="mt-3"
                data-testid="update-backup-switch"
              />
            </div>
          </div>
        </motion.div>
      </CardContent>
      <CardFooter className="border-0 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => navigate(location.state?.from || '/apps')}>
          <ChevronLeft className="me-1" size={16} />
          {t('COMMON_CANCEL')}
        </Button>
        <Button
          onClick={() =>
            update.mutate({
              path: { urn: info.urn },
              body: { performBackup: backupApp },
            })
          }
          intent="success"
          loading={update.isPending}
          data-testid="update-confirm"
        >
          {t('COMMON_UPDATE')}
        </Button>
      </CardFooter>
    </Card>
  );
}
