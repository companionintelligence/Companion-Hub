import { updateAppMetadataMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';
import { CURRENT_SCHEMA_VERSION } from '@ci-hub/common/schemas';
import { AlertCircle, AlertTriangle, ExternalLink, HardDrive, Shield } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Suspense } from 'react';
import React from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const AppDescriptionEditor = React.lazy(() =>
  import('../../components/app-description-editor/app-description-editor').then((module) => ({ default: module.AppDescriptionEditor })),
);

interface IProps {
  info: AppInfo;
  app?: AppDetails | null;
  metadata?: AppMetadata;
  imageSizeFormatted?: string | null;
  imageSizeLoading?: boolean;
}

export const AppDetailsTabs = ({ info, app: _app, metadata, imageSizeFormatted, imageSizeLoading }: IProps) => {
  const { t } = useTranslation();

  const urn = extractAppUrn(info.urn as AppUrn);
  const isUserApp = urn.appStoreId === '_user';

  const [isEditing, setIsEditing] = React.useState(false);
  const [meta, setMeta] = React.useState(info.description);
  const schemaVersion = metadata?.composeSchemaVersion;

  const saveMetaMutation = useMutation({
    ...updateAppMetadataMutation(),
    onSuccess: () => {
      setIsEditing(false);
      toast.success(t('APP_NOTES_SAVE_SUCCESS'));
    },
    onError: () => {
      toast.error(t('APP_ERROR_SAVE_NOTES'));
    },
  });

  const updatedDate = info.updated_at
    ? new Date(info.updated_at * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
    : null;

  return (
    <div style={{ marginTop: -1 }}>
      {info.deprecated && (
        <Alert variant="danger" className="mb-4">
          <AlertIcon>
            <AlertCircle strokeWidth={2} />
          </AlertIcon>
          <div>
            <AlertHeading>{t('APP_DETAILS_DEPRECATED_ALERT_TITLE')}</AlertHeading>
            <AlertDescription>{t('APP_DETAILS_DEPRECATED_ALERT_SUBTITLE')}</AlertDescription>
          </div>
        </Alert>
      )}
      <Alert variant="warning" className={cn('mb-4', { hidden: schemaVersion === undefined || schemaVersion >= CURRENT_SCHEMA_VERSION })}>
        <AlertIcon>
          <AlertTriangle strokeWidth={2} />
        </AlertIcon>
        <div>
          <AlertHeading>{t('APP_COMPOSE_SCHEMA_OUTDATED_ALERT_TITLE')}</AlertHeading>
          <AlertDescription>
            {t('APP_COMPOSE_SCHEMA_OUTDATED_ALERT_SUBTITLE', {
              version: schemaVersion,
            })}
          </AlertDescription>
        </div>
      </Alert>

      {/* Two-column portal-style layout */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr,280px] gap-6 md:gap-8">
        {/* Left column - About this app */}
        <div className="space-y-6">
          <div>
            {isUserApp && (
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold">{t('APP_DETAILS_NOTES')}</h2>
                {!isEditing && (
                  <Button variant="outline" size="sm" onClick={() => setIsEditing(!isEditing)}>
                    {t('EDIT')}
                  </Button>
                )}
                {isEditing && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      intent="danger"
                      size="sm"
                      onClick={() => {
                        setIsEditing(false);
                        setMeta(info.description);
                      }}
                    >
                      {t('ACTIONS_CANCEL')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        saveMetaMutation.mutate({
                          path: { urn: info.urn },
                          body: { data: meta },
                        })
                      }
                      loading={saveMetaMutation.isPending}
                    >
                      {t('SAVE')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!isUserApp && <h2 className="text-lg font-semibold mb-3">{t('APP_DETAILS_ABOUT')}</h2>}
            <div className="text-sm text-muted-foreground leading-relaxed">
              <Suspense>
                <AppDescriptionEditor isEditing={isEditing} meta={meta} setMeta={setMeta} />
              </Suspense>
            </div>
          </div>
        </div>

        {/* Right column - Information */}
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold mb-4">{t('APP_DETAILS_INFORMATION')}</h2>
            <div className="space-y-4">
              <div className="flex justify-between items-start">
                <span className="text-sm text-muted-foreground">{t('APP_DETAILS_PROVIDER')}</span>
                <span className="text-sm font-medium text-right">{info.author}</span>
              </div>
              <div className="border-t border-border/40" />
              <div className="flex justify-between items-start">
                <span className="text-sm text-muted-foreground">{t('APP_DETAILS_CATEGORIES_TITLE')}</span>
                <span className="text-sm font-medium text-right capitalize">
                  {info.categories?.map((c) => t(`APP_CATEGORY_${c.toUpperCase() as Uppercase<typeof c>}`)).join(', ')}
                </span>
              </div>
              <div className="border-t border-border/40" />
              {updatedDate && (
                <>
                  <div className="flex justify-between items-start">
                    <span className="text-sm text-muted-foreground">{t('APP_DETAILS_UPDATED')}</span>
                    <span className="text-sm font-medium">{updatedDate}</span>
                  </div>
                  <div className="border-t border-border/40" />
                </>
              )}
              <div className="flex justify-between items-start">
                <span className="text-sm text-muted-foreground">{t('APP_DETAILS_VERSION')}</span>
                <span className="text-sm font-medium">{info.version}</span>
              </div>
              <div className="border-t border-border/40" />
              <div className="flex justify-between items-start">
                <span className="text-sm text-muted-foreground">{t('APP_DETAILS_SOURCE_CODE')}</span>
                <a target="_blank" rel="noreferrer" className="text-sm text-blue-500 hover:underline" href={info.source}>
                  {t('APP_DETAILS_LINK')}
                  <ExternalLink size={12} className="ml-1 mb-0.5 inline" />
                </a>
              </div>
              {info.website && (
                <>
                  <div className="border-t border-border/40" />
                  <div className="flex justify-between items-start">
                    <span className="text-sm text-muted-foreground">{t('APP_DETAILS_WEBSITE')}</span>
                    <a target="_blank" rel="noreferrer" className="text-sm text-blue-500 hover:underline truncate max-w-[160px]" href={info.website}>
                      {t('APP_DETAILS_LINK')}
                      <ExternalLink size={12} className="ml-1 mb-0.5 inline" />
                    </a>
                  </div>
                </>
              )}
              <div className="border-t border-border/40" />
              <div className="flex justify-between items-start">
                <span className="text-sm text-muted-foreground">{t('APP_DETAILS_DOWNLOAD_SIZE')}</span>
                <span className="text-sm font-medium flex items-center gap-1">
                  <HardDrive size={13} />
                  {imageSizeLoading ? 'Calculating...' : imageSizeFormatted ? `~${imageSizeFormatted}` : 'Unknown'}
                </span>
              </div>
            </div>
          </div>

          {/* App Privacy card */}
          <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="h-4 w-4 text-blue-400" />
              <span className="text-sm font-semibold">{t('APP_DETAILS_APP_PRIVACY')}</span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{t('APP_DETAILS_APP_PRIVACY_DESC')}</p>
            <div className="flex items-center gap-2 rounded-lg bg-muted/30 p-2.5">
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
              <div>
                <p className="text-xs font-medium">{t('APP_DETAILS_DATA_COLLECTION')}</p>
                <p className="text-xs text-muted-foreground">{t('APP_DETAILS_NO_DATA_COLLECTED')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
