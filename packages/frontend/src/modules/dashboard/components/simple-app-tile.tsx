import { AppLogo } from '@/components/app-logo/app-logo';

interface SimpleAppTileProps {
  name: string;
  urn: string;
}

export const SimpleAppTile = ({ name, urn }: SimpleAppTileProps) => (
  <div className="flex flex-col items-center text-center p-2 cursor-pointer hover:opacity-80 transition-opacity w-full">
    <div className="mb-2">
      <AppLogo urn={urn} alt={name} size={56} className="rounded-xl shadow-sm" />
    </div>
    <div className="truncate w-full font-medium text-xs sm:text-sm" title={name}>
      {name}
    </div>
  </div>
);
