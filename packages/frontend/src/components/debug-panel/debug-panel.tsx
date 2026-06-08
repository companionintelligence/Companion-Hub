import { useState, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  backupAllAppsMutation,
  incrementAllAppVersionsMutation,
  seedDatabaseMutation,
  setAllAppSubnetToNullMutation,
  setAllAppUpdateAvailableMutation,
  startAllAppsMutation,
  uninstallAllAppsMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { Button } from '../ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import './debug-panel.css';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const DebugPanel = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);

  const isDevelopment = import.meta.env.DEV;

  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key) {
      setPressedKeys((prev) => new Set(prev).add(event.key.toLowerCase()));
    }
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    setPressedKeys((prev) => {
      const newSet = new Set(prev);
      if (event.key) {
        newSet.delete(event.key.toLowerCase());
      }
      return newSet;
    });
  }, []);

  useEffect(() => {
    const checkKeys = () => {
      if (pressedKeys.has('d') && pressedKeys.has('e') && pressedKeys.has('v')) {
        setIsVisible(true);
      }
    };

    checkKeys();
  }, [pressedKeys]);

  useEffect(() => {
    if (!isDevelopment) {
      return;
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  const seedMutation = useMutation({
    ...seedDatabaseMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_SEED_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_SEED_FAILED'));
    },
  });

  const startAllApps = useMutation({
    ...startAllAppsMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_START_ALL_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_START_ALL_FAILED'));
    },
  });

  const subnetsMutation = useMutation({
    ...setAllAppSubnetToNullMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_SUBNETS_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_SUBNETS_FAILED'));
    },
  });

  const versionMutation = useMutation({
    ...setAllAppUpdateAvailableMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_VERSION_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_VERSION_FAILED'));
    },
  });

  const backupAllApps = useMutation({
    ...backupAllAppsMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_BACKUP_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_BACKUP_FAILED'));
    },
  });

  const incrementAllAppVersions = useMutation({
    ...incrementAllAppVersionsMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_INCREMENT_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_INCREMENT_FAILED'));
    },
  });

  const uninstallAllApps = useMutation({
    ...uninstallAllAppsMutation(),
    onSuccess: () => {
      toast.success(t('DEBUG_UNINSTALL_SUCCESS'));
    },
    onError: () => {
      toast.error(t('DEBUG_UNINSTALL_FAILED'));
    },
  });

  // Don't render anything if not in development mode
  if (!isDevelopment) {
    return null;
  }

  return (
    <>
      {isVisible && (
        <Card className="debug-panel">
          <CardHeader className="flex flex-row justify-between items-center p-4">
            <CardTitle>{t('DEBUG_TITLE')}</CardTitle>
            <Button variant="ghost" intent="danger" size="sm" aria-label={t('COMMON_CLOSE')} onClick={() => setIsVisible(false)}>
              <X size={16} />
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4 pt-0">
            <Button onClick={() => seedMutation.mutate({})}>{seedMutation.isPending ? t('DEBUG_SEEDING') : t('DEBUG_SEED_DATABASE')}</Button>
            <Button onClick={() => startAllApps.mutate({})}>{startAllApps.isPending ? t('DEBUG_STARTING_ALL') : t('DEBUG_START_ALL')}</Button>
            <Button onClick={() => subnetsMutation.mutate({})}>
              {subnetsMutation.isPending ? t('DEBUG_SETTING_SUBNETS') : t('DEBUG_SET_SUBNETS')}
            </Button>
            <Button onClick={() => versionMutation.mutate({})}>
              {versionMutation.isPending ? t('DEBUG_SETTING_VERSION') : t('DEBUG_SET_VERSION')}
            </Button>
            <Button onClick={() => backupAllApps.mutate({})}>{backupAllApps.isPending ? t('DEBUG_BACKING_UP_ALL') : t('DEBUG_BACKUP_ALL')}</Button>
            <Button onClick={() => incrementAllAppVersions.mutate({})}>
              {incrementAllAppVersions.isPending ? t('DEBUG_INCREMENTING_VERSIONS') : t('DEBUG_INCREMENT_VERSIONS')}
            </Button>
            <Button onClick={() => uninstallAllApps.mutate({})} intent="danger">
              {uninstallAllApps.isPending ? t('DEBUG_UNINSTALLING_ALL') : t('DEBUG_UNINSTALL_ALL')}
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
};
