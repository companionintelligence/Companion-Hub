import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Star, ArrowUpCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import semver from 'semver';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';
import { useState, useEffect, useCallback } from 'react';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version } = useAppContext();

  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [autoUpdatesLoading, setAutoUpdatesLoading] = useState(false);

  const isLatest = semver.valid(version.current) && semver.valid(version.latest) && semver.gte(version.current, version.latest);

  // Fetch auto-update setting on mount
  useEffect(() => {
    fetch('/api/system/update/auto-updates', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => setAutoUpdates(data.enabled))
      .catch(() => {});
  }, []);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setUpdateMessage('Hub is restarting with the new version. This page will reload shortly.');
        setTimeout(() => window.location.reload(), 15000);
      } else {
        setUpdateMessage('Update failed. Check logs for details.');
        setUpdating(false);
      }
    } catch {
      setUpdateMessage('Update request failed. The hub may already be restarting.');
      setTimeout(() => window.location.reload(), 15000);
    }
  }, []);

  const handleAutoUpdatesToggle = useCallback(async () => {
    setAutoUpdatesLoading(true);
    const newValue = !autoUpdates;
    try {
      await fetch('/api/system/update/auto-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: newValue }),
      });
      setAutoUpdates(newValue);
    } catch {
      // ignore
    }
    setAutoUpdatesLoading(false);
  }, [autoUpdates]);

  const renderUpdate = () => {
    if (updateMessage) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm">
          {updating && <Loader2 className="h-4 w-4 animate-spin" />}
          {updateMessage}
        </div>
      );
    }

    if (isLatest) {
      return <Button disabled>{t('SETTINGS_ACTIONS_ALREADY_LATEST')}</Button>;
    }

    return (
      <div>
        <Button onClick={handleUpdate} disabled={updating} className="mb-4">
          {updating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Updating...
            </>
          ) : (
            `Update to ${version.latest}`
          )}
        </Button>
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
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Auto-update</h3>
                <p className="text-sm text-muted-foreground">Automatically update when new versions are available</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoUpdates}
                onClick={handleAutoUpdatesToggle}
                disabled={autoUpdatesLoading}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoUpdates ? 'bg-primary' : 'bg-input'} ${autoUpdatesLoading ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${autoUpdates ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>

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
