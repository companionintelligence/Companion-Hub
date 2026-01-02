import { AppLogo } from '@/components/app-logo/app-logo';

interface SimpleAppTileProps {
  name: string;
  urn: string;
}

export const SimpleAppTile = ({ name, urn }: SimpleAppTileProps) => (
  <div className="d-flex flex-column align-items-center text-center p-2 hover-effect" style={{ width: 120, cursor: 'pointer' }}>
    <div className="mb-2">
      <AppLogo urn={urn} alt={name} size={64} className="rounded-3 shadow-sm" />
    </div>
    <div className="text-truncate w-100 fw-medium" title={name}>
      {name}
    </div>
  </div>
);
