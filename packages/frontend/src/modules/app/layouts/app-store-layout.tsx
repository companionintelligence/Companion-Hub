import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';

export default () => {
  const location = useLocation();

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-6 pt-6 pb-2">
        <h2 className="text-3xl font-bold tracking-tight mb-2 text-foreground">App Store</h2>
        <p className="text-muted-foreground">Discover and manage your applications</p>
      </div>

      <div className="flex flex-1 min-h-0 pt-4">
        <AppStoreSidebar />

        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 px-6 py-4 relative">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
