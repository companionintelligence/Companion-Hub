import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Star, ArrowUpCircle } from 'lucide-react';
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_ACTIONS_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_ACTIONS_CURRENT_VERSION', { version: version.current })}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {isLatest ? t('SETTINGS_ACTIONS_STAY_UP_TO_DATE') : t('SETTINGS_ACTIONS_NEW_VERSION', { version: version.latest })}
          </p>
          {renderUpdate()}
          <div className="mt-6 pt-6 border-t">
            <h3 className="text-lg font-semibold mb-1">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</h3>
            <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')}</p>
            <UpdateRepoModal />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
