import type { CustomLink } from '@/types/app.types';
import { ExternalLink } from 'lucide-react';
import type React from 'react';
import { openExternal } from '@/lib/helpers/open-external';
import { SimpleAppTile } from './simple-app-tile';

type GuestLinkTileProps = {
  link: CustomLink;
};

/**
 * A link on the guest dashboard, drawn as the same tile as the apps beside it (Home's tile). It was a
 * card of its own with larger type, narrower than the app tiles and out of line with them.
 */
export const GuestLinkTile: React.FC<GuestLinkTileProps> = ({ link }) => (
  <button
    onClick={() => openExternal(link.url)}
    type="button"
    className="block w-full rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    data-testid={`guest-link-tile-${link.title}`}
  >
    <SimpleAppTile
      name={link.title}
      urn=""
      logoUrl={link.iconUrl || undefined}
      description={link.description || undefined}
      trailing={<ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    />
  </button>
);
