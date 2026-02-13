import { getAppComposeDiffOptions, getAppConfigDiffOptions, getAppOptions, updateAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/Card';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { StepContent, Stepper, StepTrigger, StepTriggerList } from '@/components/ui/Stepper/Stepper';
import { Switch } from '@/components/ui/Switch';
import { unifiedMergeView } from '@codemirror/merge';
import { copilot } from '@uiw/codemirror-theme-copilot';
import CodeMirror from '@uiw/react-codemirror';
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { ArrowRight, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
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

const buildVersionLabel = (latestDocker?: string | null, latestVersion?: string | number | null) => {
  return [latestDocker?.toString().trim(), latestVersion ? `(${String(latestVersion)})` : undefined].filter(Boolean).join(' ');
};

const LoadingBlock = () => {
  const { t } = useTranslation();
  return <div className="mt-3 text-muted">{t('LOADING')}</div>;
};

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
  const [currentStep, setCurrentStep] = useState(0);

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

  const newVersionLabel = useMemo(
    () => buildVersionLabel(metadata?.latestDockerVersion, metadata?.latestVersion),
    [metadata?.latestDockerVersion, metadata?.latestVersion],
  );

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
              <span className="badge bg-success text-white">{metadata.latestDockerVersion}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Stepper currentStep={currentStep}>
            <StepTriggerList>
              <StepTrigger step={0} title={t('APP_UPDATE_INFORMATION_TITLE')} onStepChange={setCurrentStep} />
              <StepTrigger step={1} title={t('APP_UPDATE_CONFIGURATION_TITLE')} onStepChange={setCurrentStep} />
              <StepTrigger step={2} title={t('APP_UPDATE_COMPOSE_TITLE')} onStepChange={setCurrentStep} />
              <StepTrigger step={3} title={t('APP_UPDATE_BACKUP_TITLE')} onStepChange={setCurrentStep} />
            </StepTriggerList>
            <div className="mt-1">
              <StepContent step={0}>
                <div className="text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="APP_UPDATE_INFORMATION_SUBTITLE"
                    values={{
                      version: newVersionLabel,
                      name: info.name,
                    }}
                    components={{ strong: <strong /> }}
                  />
                </div>
              </StepContent>
              <StepContent step={1}>
                <div className="text-muted-foreground">{t('APP_UPDATE_CONFIGURATION_SUBTITLE')}</div>
                {configDiffQuery.isLoading && <LoadingBlock />}
                {!configDiffQuery.isLoading && (
                  <ScrollArea maxheight={500} className="mt-3 border rounded">
                    <CodeMirror
                      value={configDiffQuery.data?.new ?? ''}
                      readOnly
                      height="400px"
                      theme={copilot}
                      extensions={[
                        unifiedMergeView({
                          original: configDiffQuery.data?.current ?? '',
                          mergeControls: false,
                        }),
                      ]}
                    />
                  </ScrollArea>
                )}
              </StepContent>
              <StepContent step={2}>
                <div className="text-muted-foreground">{t('APP_UPDATE_COMPOSE_SUBTITLE')}</div>
                {composeDiffQuery.isLoading && <LoadingBlock />}
                {!composeDiffQuery.isLoading && (
                  <ScrollArea maxheight={500} className="mt-3 border rounded">
                    <CodeMirror
                      value={composeDiffQuery.data?.new ?? ''}
                      readOnly
                      height="400px"
                      theme={copilot}
                      extensions={[
                        unifiedMergeView({
                          original: composeDiffQuery.data?.current ?? '',
                          mergeControls: false,
                        }),
                      ]}
                    />
                  </ScrollArea>
                )}
                <Alert variant="info" className="mt-3">
                  <AlertIcon>
                    <Info strokeWidth={2} />
                  </AlertIcon>
                  <div>
                    <AlertHeading>{t('APP_UPDATE_COMPOSE_ALERT_TITLE')}</AlertHeading>
                    <AlertDescription>{t('APP_UPDATE_COMPOSE_ALERT_SUBTITLE')}</AlertDescription>
                  </div>
                </Alert>
              </StepContent>
              <StepContent step={3}>
                <div className="text-muted-foreground">{t('APP_UPDATE_BACKUP_SUBTITLE')}</div>
                <Switch checked={backupApp} onCheckedChange={setBackupApp} label={t('APP_UPDATE_FORM_BACKUP')} className="mt-3" />
              </StepContent>
            </div>
          </Stepper>
        </motion.div>
      </CardContent>
      <CardFooter className="border-0 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => navigate(location.state?.from || '/apps')}>
          <ChevronLeft className="me-1" size={16} />
          {t('APP_ACTION_CANCEL')}
        </Button>
        <div className="flex items-center justify-end gap-2">
          {currentStep > 0 && (
            <Button variant="link" onClick={() => setCurrentStep((step) => step - 1)} className="mr-2">
              {t('APP_UPDATE_FORM_BACK')}
            </Button>
          )}
          {currentStep < 3 && (
            <Button onClick={() => setCurrentStep((step) => step + 1)}>
              {t('APP_UPDATE_FORM_NEXT')}
              <ChevronRight className="ms-2 text-muted" size={12} />
            </Button>
          )}
          {currentStep === 3 && (
            <Button
              onClick={() =>
                update.mutate({
                  path: { urn: info.urn },
                  body: { performBackup: backupApp },
                })
              }
              intent="success"
              loading={update.isPending}
            >
              {t('APP_UPDATE_FORM_SUBMIT')}
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
