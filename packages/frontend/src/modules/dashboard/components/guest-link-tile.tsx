import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import type { CustomLink } from '@/types/app.types';
import type React from 'react';
import './guest-link-tile.css';

type GuestLinkTileProps = {
  link: CustomLink;
};

export const GuestLinkTile: React.FC<GuestLinkTileProps> = ({ link }) => {
  const handleClick = () => {
    window.open(link.url, '_blank', 'noreferrer');
  };

  return (
    <button
      onClick={handleClick}
      type="button"
      className="col-sm-6 col-lg-4 app-link p-2 pt-0 pb-0 mb-0 guest-link-tile-button"
      data-testid={`guest-link-tile-${link.title}`}
    >
      <Card className="hover:bg-accent/50 transition-colors">
        <CardContent>
          <div className="flex items-center overflow-hidden">
            <span className="me-3">
              <AppLogo url={link.iconUrl || ''} size={60} />
            </span>
            <div>
              <div className="flex h-3 items-center">
                <span className="text-xl font-bold me-2 mb-1">{link.title}</span>
              </div>
              {link.description?.length !== 0 && <div className="text-muted-foreground break-words">{link.description}</div>}
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
};
