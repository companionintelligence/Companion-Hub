import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import semver from 'semver';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version } = useAppContext();

  const isLatest = semver.valid(version.current) && semver.valid(version.latest) && semver.gte(version.current, version.latest);

  const renderUpdate = () => {
    if (isLatest) {
      return <Button disabled>{t('SETTINGS_ACTIONS_ALREADY_LATEST')}</Button>;
    }

    return (
      <div>
        {version.releases?.map((release) => (
          <Card key={release.version} className="mt-3 relative overflow-hidden w-full md:w-2/3">
            <div className="absolute -right-6 -top-6 text-yellow-500 opacity-20 rotate-12 pointer-events-none">
              <Star size={80} fill="currentColor" />
            </div>
            <CardHeader>
              <CardTitle>Version {release.version}</CardTitle>
            </CardHeader>
            <CardContent>
              <Markdown className="" content={release.body} />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  return (
    <CardContent>
      <h2 className="mb-4">{t('SETTINGS_ACTIONS_TITLE')}</h2>
      <CardTitle className="mt-4">{t('SETTINGS_ACTIONS_CURRENT_VERSION', { version: version.current })}</CardTitle>
      <p className="text-muted-foreground">
        {isLatest ? t('SETTINGS_ACTIONS_STAY_UP_TO_DATE') : t('SETTINGS_ACTIONS_NEW_VERSION', { version: version.latest })}
      </p>
      {renderUpdate()}
      <CardTitle className="mt-4">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</CardTitle>
      <p className="text-muted-foreground">{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')}</p>
      <UpdateRepoModal />
    </CardContent>
  );
};
