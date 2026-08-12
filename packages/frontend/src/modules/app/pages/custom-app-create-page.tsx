import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import { z } from 'zod';
import { deriveAppSlug, RESERVED_APP_NAMES } from '@ci-hub/common/types';
import { MultiServiceForm } from '@/components/multi-service-form/multi-service-form';
import { createCustomAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Input } from '@/components/ui/Input/Input';
import { Card, CardContent } from '@/components/ui/Card';
import type { TranslatableError } from '@/types/error.types';
import { useState } from 'react';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

    createCustomApp.mutate({ body: { config: { ...data, schemaVersion: 2 }, name: displayName } });
  };

  return (
    <div className="h-full overflow-y-auto">
      <Card>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Input
                label={
                  <>
                    {t('CUSTOM_APP_NAME_LABEL')} <span className="text-destructive">*</span>
                  </>
                }
                onChange={(e) => setAppName(e.target.value)}
                error={appNameError}
                placeholder={t('CUSTOM_APP_NAME_PLACEHOLDER')}
                title={t('CUSTOM_APP_NAME_HELP')}
                disabled={createCustomApp.isPending}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('CUSTOM_APP_NAME_HELP')}
                {appName && derivedSlug ? ` ${t('CUSTOM_APP_NAME_DERIVED', { slug: derivedSlug })}` : ''}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <MultiServiceForm onSubmit={onSubmit} />
    </div>
  );
};
