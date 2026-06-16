import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet } from 'react-router';

export default () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <AppStoreSidebar />

        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-6 py-4">
          <Outlet />
        </div>
      </div>
    </div>
  );
};
