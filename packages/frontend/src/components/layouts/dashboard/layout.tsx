import { Header } from '@/components/header/header';
import { type PropsWithChildren, useEffect, useRef } from 'react';
import semver from 'semver';
import './layout.css';
import { PageTitle } from '@/components/page-title/page-title';
import { Welcome } from '@/components/welcome/welcome';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation } from 'react-router';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => {
  return (
    <div className="page">
      <Header isLoggedIn={false} isUpdateAvailable={false} allowAutoThemes={false} />
      <div className="page-wrapper">
        <div className="page-header d-print-none">
          <span className="title" />
        </div>
        <div className="page-body">
          <div className="container-xl">
            <div className="card px-3 pb-3">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { userSettings, user, apps, version } = useAppContext();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);

  const { isLoggedIn } = useUserContext();

  useEffect(() => {
    prevPathRef.current = location.pathname;
  }, [location.pathname]);

  let isLatest = semver.valid(version.current) && semver.valid(version.latest) && semver.gte(version.current, version.latest);

  if (version.current === 'nightly') {
    isLatest = true;
  }

  if (!user.hasSeenWelcome) {
    return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;
  }

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
      y: direction > 0 ? '100%' : 0,
      opacity: direction > 0 ? 1 : 0,
      zIndex: direction > 0 ? 10 : 0,
    }),
    center: {
      y: 0,
      opacity: 1,
      zIndex: 1,
      pointerEvents: 'auto',
    },
    exit: (direction: number) => ({
      y: direction < 0 ? '100%' : 0,
      opacity: direction < 0 ? 1 : 0,
      zIndex: direction < 0 ? 10 : 0,
      pointerEvents: 'none',
    }),
  };

  const _isAppStore = location.pathname.startsWith('/app-store');
  const shouldShowTitle = !['/dashboard', '/apps', '/settings', '/app-store'].includes(location.pathname);

  return (
    <div className="page fixed inset-0 overflow-hidden flex flex-col">
      <Header isLoggedIn={isLoggedIn} isUpdateAvailable={!isLatest} allowAutoThemes={userSettings.allowAutoThemes} />
      <div className="page-wrapper flex-1 flex flex-col relative overflow-hidden min-h-0">
        {shouldShowTitle && (
          <div className="page-header d-print-none z-20 relative">
            <div className="container-xl">
              <div className="text-reset title">
                <PageTitle apps={apps} />
              </div>
            </div>
          </div>
        )}
        <div className="page-body flex-1 relative overflow-hidden min-h-0">
          <div className="container-xl h-full relative">
            <AnimatePresence mode="popLayout" custom={direction}>
              <motion.div
                key={location.pathname}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.6, ease: 'easeInOut' }}
                className="absolute inset-0 w-full h-full overflow-hidden"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
};
