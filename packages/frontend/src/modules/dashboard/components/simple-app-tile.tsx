import { AppLogo } from '@/components/app-logo/app-logo';
import { Loader2 } from 'lucide-react';

interface SimpleAppTileProps {
  name: string;
  urn: string;
  isInstalling?: boolean;
}

export const SimpleAppTile = ({ name, urn, isInstalling }: SimpleAppTileProps) => (
  <div className="flex flex-col items-center text-center p-2 cursor-pointer hover:opacity-80 transition-opacity w-full">
    <div className="mb-2 relative">
      <AppLogo urn={urn} alt={name} size={56} className={`rounded-xl shadow-sm${isInstalling ? ' opacity-40' : ''}`} />
      {isInstalling && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      )}
    </div>
    <div className="truncate w-full font-medium text-xs sm:text-sm" title={name}>
      {name}
    </div>
    {isInstalling && (
      <div className="w-full mt-1 h-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
      </div>
    )}
  </div>
);
