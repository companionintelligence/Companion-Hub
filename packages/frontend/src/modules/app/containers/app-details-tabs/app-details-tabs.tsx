import { updateAppMetadataMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DataGrid, DataGridItem } from '@/components/ui/DataGrid';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { CURRENT_SCHEMA_VERSION } from '@runtipi/common/schemas';
import { AlertCircle, AlertTriangle, ExternalLink, HardDrive } from 'lucide-react';
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
}

export const AppDetailsTabs = ({ info, app: _app, metadata, imageSizeFormatted }: IProps) => {
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

      {/* Description / Notes */}
      <Card>
        {isUserApp && (
          <CardHeader className="flex flex-row justify-between items-center space-y-0 p-6">
            <h3 className="mb-0 font-semibold text-lg">{t('APP_DETAILS_NOTES')}</h3>
            {!isEditing && (
              <Button variant="outline" onClick={() => setIsEditing(!isEditing)}>
                {t('EDIT')}
              </Button>
            )}
            {isEditing && (
              <div>
                <Button
                  variant="outline"
                  intent="danger"
                  onClick={() => {
                    setIsEditing(false);
                    setMeta(info.description);
                  }}
                >
                  {t('ACTIONS_CANCEL')}
                </Button>
                <Button
                  variant="outline"
                  className="ml-2"
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
          </CardHeader>
        )}
        <CardContent className="pt-6 text-sm">
          <Suspense>
            <AppDescriptionEditor isEditing={isEditing} meta={meta} setMeta={setMeta} />
          </Suspense>
        </CardContent>
      </Card>

      {/* Base Info */}
      <Card className="mt-4">
        <CardContent className="pt-6">
          <DataGrid>
            <DataGridItem title={t('APP_DETAILS_SOURCE_CODE')}>
              <a target="_blank" rel="noreferrer" className="text-blue-500 text-xs" href={info.source}>
                {t('APP_DETAILS_LINK')}
                <ExternalLink size={15} className="ml-1 mb-1 inline" />
              </a>
            </DataGridItem>
            <DataGridItem title={t('APP_DETAILS_AUTHOR')}>{info.author}</DataGridItem>
            <DataGridItem title={t('APP_DETAILS_CATEGORIES_TITLE')}>
              {info.categories?.map((c) => (
                <span key={c} className="inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-500 mr-1">
                  {t(`APP_CATEGORY_${c.toUpperCase() as Uppercase<typeof c>}`)}
                </span>
              ))}
            </DataGridItem>
            <DataGridItem title={t('APP_DETAILS_VERSION')}>{info.version}</DataGridItem>
            {info.website && (
              <DataGridItem title={t('APP_DETAILS_WEBSITE')}>
                <a target="_blank" rel="noreferrer" className="text-blue-500 text-xs" href={info.website}>
                  {info.website}
                  <ExternalLink size={15} className="ml-1 mb-1 inline" />
                </a>
              </DataGridItem>
            )}
            {imageSizeFormatted && (
              <DataGridItem title="Download Size">
                <span className="flex items-center gap-1">
                  <HardDrive size={15} />~{imageSizeFormatted}
                </span>
              </DataGridItem>
            )}
          </DataGrid>
        </CardContent>
      </Card>
    </div>
  );
};
