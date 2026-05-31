import { AppStoreSidebar } from '../components/app-store-sidebar/app-store-sidebar';
import { Outlet } from 'react-router';

export default () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-1 min-h-0">
        <AppStoreSidebar />

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
          <Outlet />
        </div>
      </div>
    </div>
  );
};
