import { Header } from '@/components/header/header';
import { type PropsWithChildren, useEffect, useRef } from 'react';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { CoreServerBanner } from '@/components/core-server-banner/core-server-banner';
import { shouldShowCoreServerBanner } from '@/components/core-server-banner/core-server-banner-visibility';
import { useCoreServerBanner } from '@/hooks/use-core-server-banner';
import { TunnelStatusBanner } from '@/components/tunnel-status-banner/tunnel-status-banner';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => {
  return (
    <div className="flex bg-background overflow-hidden w-screen flex-col" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <Header isLoggedIn={false} allowAutoThemes={false} />
      <div className="flex flex-1 flex-col pt-16 px-2 sm:px-4 container mx-auto h-full overflow-y-auto no-scrollbar">
        <div className="rounded-lg border bg-card text-card-foreground shadow p-6">{children}</div>
      </div>
    </div>
  );
};

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { user, userSettings } = useAppContext();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const { isLoggedIn } = useUserContext();
  const { data: systemData } = useQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
    staleTime: 30_000,
  });

  const diskSnapshot = systemData ? { diskUsed: systemData.diskUsed, diskSize: systemData.diskSize } : undefined;

  const diskProbeKey =
    diskSnapshot && shouldShowCoreServerBanner({ system: diskSnapshot }) ? diskSnapshot.diskUsed * 1_000_000_000 + diskSnapshot.diskSize : undefined;
  const { isDismissed, dismiss } = useCoreServerBanner(diskProbeKey);

  const showCoreServerBanner =
    !isDismissed &&
    shouldShowCoreServerBanner({
      system: diskSnapshot,
    });

  useEffect(() => {
    prevPathRef.current = location.pathname;
  }, [location.pathname]);

  // Redirect to onboarding if not completed
  if (!user.hasCompletedOnboarding && !location.pathname.startsWith('/onboarding')) {
    return <Navigate to="/onboarding" replace />;
  }

  // Transition logic
  const getDepth = (path: string) => {
    if (path === '/home') return 0;
    if (path.startsWith('/apps') || path.startsWith('/store') || path.startsWith('/settings') || path.startsWith('/resource-monitor')) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length > 1 && (parts[0] === 'apps' || parts[0] === 'app-store')) return 2;
      return 1;
    }
    return 1;
  };

  // Routes that use a layout with a persistent sidebar should share a single
  // animation key so the outer wrapper (sidebar + header) doesn't re-mount
  // and swipe during navigation within the same section.
  const getAnimationKey = (path: string) => {
    if (path.startsWith('/store')) return '/store';
    if (path.startsWith('/resource-monitor')) return '/resource-monitor';
    return path;
  };

  const currentDepth = getDepth(location.pathname);
  const prevDepth = getDepth(prevPathRef.current);
  let direction = 0;

  if (currentDepth > prevDepth) direction = 1;
  else if (currentDepth < prevDepth) direction = -1;

  const variants = {
    enter: (direction: number) => ({
      x: direction > 0 ? 1000 : -1000,
      opacity: 0,
    }),
    center: {
      zIndex: 1,
      x: 0,
      opacity: 1,
    },
    exit: (direction: number) => ({
      zIndex: 0,
      x: direction < 0 ? 1000 : -1000,
      opacity: 0,
    }),
  };

  return (
    <div className="flex bg-background overflow-hidden w-screen flex-col" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <Header isLoggedIn={isLoggedIn} allowAutoThemes={userSettings.allowAutoThemes} />
      <main className="relative flex flex-1 flex-col gap-4 pt-16 px-2 sm:px-4 container mx-auto h-full overflow-y-auto overflow-x-hidden no-scrollbar">
        {showCoreServerBanner && <CoreServerBanner onDismiss={dismiss} />}
        <TunnelStatusBanner />
        <AnimatePresence mode="popLayout" custom={direction}>
          <motion.div
            key={getAnimationKey(location.pathname)}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              x: { type: 'spring', stiffness: 300, damping: 30 },
              opacity: { duration: 0.2 },
            }}
            className="w-full flex-1"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};
