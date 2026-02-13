import { Header } from '@/components/header/header';
import { type PropsWithChildren, useEffect, useRef } from 'react';
import semver from 'semver';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation } from 'react-router';
import { Welcome } from '@/components/welcome/welcome';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => {
  return (
    <div className="flex bg-background overflow-hidden h-screen w-screen flex-col">
      <Header isLoggedIn={false} isUpdateAvailable={false} allowAutoThemes={false} />
      <div className="flex flex-1 flex-col pt-24 px-4 container mx-auto h-full overflow-y-auto no-scrollbar">
        <div className="rounded-xl border bg-card text-card-foreground shadow p-6">{children}</div>
      </div>
    </div>
  );
};

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { user, userSettings, version } = useAppContext();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const { isLoggedIn } = useUserContext();

  useEffect(() => {
    prevPathRef.current = location.pathname;
  }, [location.pathname]);

  // Version check logic
  let isLatest = false;
  try {
    isLatest = (semver.valid(version.current) && semver.valid(version.latest) && semver.gte(version.current, version.latest)) || false;
  } catch (_e) {
    // ignore semver errors
  }

  if (version.current === 'nightly') {
    isLatest = true;
  }

  if (!user.hasSeenWelcome) {
    return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;
  }

  // Transition logic
  const getDepth = (path: string) => {
    if (path === '/dashboard') return 0;
    if (path.startsWith('/apps') || path.startsWith('/app-store') || path.startsWith('/settings')) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length > 1 && (parts[0] === 'apps' || parts[0] === 'app-store')) return 2;
      return 1;
    }
    return 1;
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
    <div className="flex bg-background overflow-hidden h-screen w-screen flex-col">
      <Header isLoggedIn={isLoggedIn} isUpdateAvailable={!isLatest} allowAutoThemes={userSettings.allowAutoThemes} />

      <main className="flex-1 relative pt-24 px-4 container mx-auto h-full overflow-y-auto overflow-x-hidden no-scrollbar">
        <AnimatePresence mode="popLayout" custom={direction}>
          <motion.div
            key={location.pathname}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              x: { type: 'spring', stiffness: 300, damping: 30 },
              opacity: { duration: 0.2 },
            }}
            className="w-full h-full"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};
