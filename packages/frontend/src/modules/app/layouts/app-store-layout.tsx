import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet } from 'react-router';

export default () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex min-h-0 flex-1">
        <AppStoreSidebar />

        <div
          className="page-scroller-edge-2 relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden py-3 pl-2 sm:page-scroller-edge-4 sm:py-4 sm:pl-4 md:page-scroller-edge-6 md:pl-6"
          data-page-scroller="store"
        >
          <Outlet />
        </div>
      </div>
    </div>
  );
};
