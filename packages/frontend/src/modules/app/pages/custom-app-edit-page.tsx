import { useTranslation } from 'react-i18next';
import { redirect, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { dynamicComposeFormSchema, safeParseKeepingBuilderEnforcedLabels, type dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import { AlertCircle } from 'lucide-react';
import { MultiServiceForm } from '@/components/multi-service-form/multi-service-form';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Input } from '@/components/ui/Input/Input';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import type { TranslatableError } from '@/types/error.types';
import { useEffect, useId, useState } from 'react';
import { describeComposeIssue, useMultiServiceStore } from '@/stores/multiServiceStore';
import { getAppComposeDiffOptions, getAppComposeDiffQueryKey, getAppOptions, updateCustomAppMutation } from '@/api-client/@tanstack/react-query.gen';
import type { Route } from './+types/custom-app-edit-page';
import { getAppComposeDiff } from '@/api-client';

export async function clientLoader({ params }: Route.ActionArgs) {
  if (!params.appId) {
    return redirect('/apps');
  }

  // The compose holds the app's env values, so reading it takes an owner or admin. Anyone else lands on
  // the app's page rather than on an error.
  const composeDiff = await getAppComposeDiff({ path: { urn: `${params.appId}:_user` } }).catch(() => null);

  // The client answers a refusal with the error rather than throwing it.
  const refused = composeDiff?.response?.status === 401 || composeDiff?.response?.status === 403;
  if (!composeDiff || refused) {
    return redirect(`/apps/${encodeURIComponent(params.appId)}`);
  }

  if (!composeDiff.data?.current) {
    return redirect('/apps');
  }

  return { composeDiff: composeDiff.data };
}

export default function EditPageContent({ loaderData }: Route.ComponentProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  /** Each label the saved config holds that a save now refuses, in the words the save uses for it. */
  const [refusedLabels, setRefusedLabels] = useState<string[]>([]);
  const params = useParams<{ appId: string }>();

  const [appName] = useState(params.appId);
  const { loadSaved } = useMultiServiceStore();
  // Bumped each time the config is read into the store. The form's rows are drawn from its first values,
  // so a config read again while the page is open gives the form a new key.
  const [loadCount, setLoadCount] = useState(0);
  const queryClient = useQueryClient();

  const { data: currentConfig } = useQuery({
    ...getAppComposeDiffOptions({ path: { urn: `${params.appId}:_user` } }),
    initialData: loaderData?.composeDiff,
    staleTime: 30_000,
  });

  const id = useId();

  // The name the app was created with ("Family Photos"); the URL only holds its identifier.
  const { data: appRecord } = useQuery({ ...getAppOptions({ path: { urn: `${params.appId}:_user` } }), staleTime: 30_000 });
  const displayName = appRecord?.info?.name ?? appName ?? '';

  useEffect(() => {
    if (!currentConfig?.current) {
      return;
    }

    try {
      // A config saved before a label rule existed still opens, with those labels in it, so they can be
      // removed here. Until then the Hub leaves them out each time the app starts or restarts.
      const parsed = safeParseKeepingBuilderEnforcedLabels(dynamicComposeFormSchema, JSON.parse(currentConfig.current));
      if (!parsed.success) {
        setConfigError(t('CUSTOM_APP_INVALID_CONFIG'));
        return;
      }

      const servicesWithId = parsed.data.services.map((service) => ({
        _id: id + Math.random().toString(36).substring(2, 9),
        ...service,
      }));

      setConfigError(null);
      // The overrides are kept beside the form, which has no fields for them, so a save writes them back.
      loadSaved(servicesWithId, parsed.data.overrides);
      setLoadCount((count) => count + 1);
      // All of them, so they can go in one save. A save names the first one left.
      const values = { services: servicesWithId, overrides: parsed.data.overrides };
      const refusals = parsed.labelIssues.map((issue) => describeComposeIssue([issue], values));
      // Kept when unchanged, so the same config read again doesn't render the page again.
      setRefusedLabels((current) =>
        current.length === refusals.length && current.every((refusal, index) => refusal === refusals[index]) ? current : refusals,
      );
      setReady(true);
    } catch {
      setConfigError(t('CUSTOM_APP_INVALID_CONFIG'));
    }
  }, [currentConfig, loadSaved, t, id]);

  const updateCustomApp = useMutation({
    ...updateCustomAppMutation(),
    onSuccess: () => {
      toast.success(t('CUSTOM_APP_UPDATE_SUCCESS', { name: appName }));
      // The editor fills itself from this query, which stays fresh for 30 seconds and wins over the
      // loader's newer answer. Without this, opening the editor again right after a save showed the
      // config from before it. Saving that view put the old config back.
      void queryClient.invalidateQueries({ queryKey: getAppComposeDiffQueryKey({ path: { urn: `${params.appId}:_user` } }) });
      navigate(`/apps/${appName}`);
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message || 'CUSTOM_APP_UPDATE_ERROR', { ...error.intlParams }));
    },
  });

  const onSubmit = (data: z.infer<typeof dynamicComposeSchema>) => {
    // Awaited by the form, which keeps Save all and Save JSON disabled until it settles. A failure is
    // reported by the mutation's onError.
    return updateCustomApp
      .mutateAsync({ body: { config: { ...data, schemaVersion: 2 } }, path: { urn: `${params.appId}:_user` } })
      .catch(() => undefined);
  };

  if (configError) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">{configError}</p>
        <Button type="button" variant="outline" onClick={() => navigate(`/apps/${appName}`)}>
          {t('COMMON_BACK')}
        </Button>
      </div>
    );
  }

  if (!ready) {
    return <div>{t('COMMON_LOADING')}</div>;
  }

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="custom-app-edit">
      <div className="mx-auto max-w-6xl pb-20">
        {refusedLabels.length > 0 && (
          <Alert variant="danger" className="mb-4" data-testid="custom-app-edit-refused-label">
            <AlertIcon>
              <AlertCircle strokeWidth={2} />
            </AlertIcon>
            <div>
              <AlertHeading>{t('CUSTOM_APP_EDIT_REFUSED_LABELS_TITLE')}</AlertHeading>
              {refusedLabels.map((refusal, index) => (
                // By position too: two overrides without an architecture can name the same label in the same words.
                // biome-ignore lint/suspicious/noArrayIndexKey: the list only changes when the config is read again
                <AlertDescription key={`${index}-${refusal}`}>{i18n.exists(refusal) ? t(refusal) : refusal}</AlertDescription>
              ))}
              <AlertDescription>{t('CUSTOM_APP_EDIT_REFUSED_LABELS_HINT')}</AlertDescription>
            </div>
          </Alert>
        )}
        <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl font-medium tracking-tight">{t('CUSTOM_APP_EDIT_TITLE', { name: displayName })}</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('CUSTOM_APP_EDIT_SUBTITLE')}</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Input
                  label={t('CUSTOM_APP_NAME_LABEL')}
                  value={displayName}
                  disabled={true}
                  placeholder={t('CUSTOM_APP_NAME_PLACEHOLDER')}
                  title={t('CUSTOM_APP_NAME_VALIDATION_HELP')}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('CUSTOM_APP_NAME_EDIT_HELP')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <MultiServiceForm
          key={loadCount}
          onSubmit={onSubmit}
          submitLabel={t('MULTI_SERVICE_SAVE_CHANGES')}
          onCancel={() => navigate(`/apps/${appName}`)}
        />
      </div>
    </div>
  );
}
