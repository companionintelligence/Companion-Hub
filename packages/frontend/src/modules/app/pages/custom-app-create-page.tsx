import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import { z } from 'zod';
import { deriveAppSlug, RESERVED_APP_NAMES } from '@ci-hub/common/types';
import { MultiServiceForm } from '@/components/multi-service-form/multi-service-form';
import { createCustomAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Input } from '@/components/ui/Input/Input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import type { TranslatableError } from '@/types/error.types';
import { useLayoutEffect, useState } from 'react';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const resetToDefaults = useMultiServiceStore((state) => state.resetToDefaults);

  // Create starts from a blank app. Edit fills this same store from the saved
  // config, so it must not reset. The form reads the store on its first render and
  // its environment, volume and port rows keep what they read, so it waits for the
  // reset. A layout effect finishes that wait before the page is first painted.
  const [storeIsReset, setStoreIsReset] = useState(false);
  useLayoutEffect(() => {
    resetToDefaults();
    setStoreIsReset(true);
  }, [resetToDefaults]);
  const [appName, setAppName] = useState('');
  const [appNameError, setAppNameError] = useState<string>();

  // The display name is free-form; the URL-safe slug used as the app
  // identifier is derived from it. The backend re-derives and enforces it.
  const derivedSlug = deriveAppSlug(appName || '');
  const appNameSchema = z.string().min(1, t('CUSTOM_APP_NAME_REQUIRED')).max(50, t('CUSTOM_APP_NAME_MAX_LENGTH'));

  const createCustomApp = useMutation({
    ...createCustomAppMutation(),
    onSuccess: (data) => {
      toast.success(t('CUSTOM_APP_CREATE_SUCCESS', { name: appName }));
      // Navigate by the derived slug returned from the server, not the
      // free-form display name (the URL segment is the app identifier).
      navigate(`/apps/${data?.appName ?? derivedSlug}`);
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message || 'CUSTOM_APP_CREATE_ERROR', { ...error.intlParams }));
    },
  });

  const onSubmit = (data: z.infer<typeof dynamicComposeSchema>) => {
    const displayName = appName.trim();
    const validation = appNameSchema.safeParse(displayName);
    if (!validation.success) {
      setAppNameError(z.prettifyError(validation.error));
      return;
    }

    const slug = deriveAppSlug(displayName);
    if (!slug) {
      setAppNameError(t('CUSTOM_APP_NAME_NO_SLUG'));
      return;
    }
    if (RESERVED_APP_NAMES.includes(slug)) {
      setAppNameError(t('CUSTOM_APP_NAME_RESERVED'));
      return;
    }
    setAppNameError(undefined);

    // Awaited by the form, which keeps Save all and Save JSON disabled until it settles. A failure is
    // reported by the mutation's onError.
    return createCustomApp.mutateAsync({ body: { config: { ...data, schemaVersion: 2 }, name: displayName } }).catch(() => undefined);
  };

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="custom-app-create">
      {/* The same frame as Expose a port and the app page this leads to: one width, a header card with the
          title and what the page does, then the services. */}
      <div className="mx-auto max-w-6xl pb-20">
        <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-2xl font-medium tracking-tight">{t('CUSTOM_APP_CREATE_TITLE')}</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('CUSTOM_APP_CREATE_SUBTITLE')}</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Input
                  label={
                    <>
                      {t('CUSTOM_APP_NAME_LABEL')} <span className="text-destructive">*</span>
                    </>
                  }
                  onChange={(e) => setAppName(e.target.value)}
                  aria-describedby="custom-app-name-help"
                  error={appNameError}
                  placeholder={t('CUSTOM_APP_NAME_PLACEHOLDER')}
                  title={t('CUSTOM_APP_NAME_HELP')}
                  disabled={createCustomApp.isPending}
                />
                <p id="custom-app-name-help" className="mt-1 text-xs text-muted-foreground">
                  {t('CUSTOM_APP_NAME_HELP')}
                  {appName && derivedSlug ? ` ${t('CUSTOM_APP_NAME_DERIVED', { slug: derivedSlug })}` : ''}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        {storeIsReset && <MultiServiceForm onSubmit={onSubmit} submitLabel={t('CUSTOM_APP_CREATE_BUTTON')} onCancel={() => navigate('/store')} />}
      </div>
    </div>
  );
};
