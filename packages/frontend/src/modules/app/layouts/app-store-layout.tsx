import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet } from 'react-router';

export default () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <AppStoreSidebar />

        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-2 py-3 sm:px-4 sm:py-4 md:px-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
};
