import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet } from 'react-router';

export default () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <AppStoreSidebar />

        <div className="flex-1 min-h-full min-w-0 overflow-x-hidden px-6 py-4">
          <Outlet />
        </div>
      </div>
    </div>
  );
};
