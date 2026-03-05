import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { GlassContainer } from '@/components/ui/glass-container';
import { limitText } from '@/lib/helpers/text-helpers';
import type { AppInfoSimple } from '@/types/app.types';
import { Download } from 'lucide-react';
import type React from 'react';
import { Link } from 'react-router';

interface AppCardProps {
  app: AppInfoSimple;
  isLoading?: boolean;
}

export const AppCard: React.FC<AppCardProps> = ({ app, isLoading }) => {
  if (isLoading) {
    return (
      <GlassContainer className="h-full p-4 flex flex-col min-h-[220px]" intensity="low">
        <div className="flex items-start justify-between mb-4">
          <Skeleton className="w-16 h-16 rounded-xl" />
          <Skeleton className="w-12 h-6 rounded-full" />
        </div>
        <Skeleton className="h-6 w-3/4 mb-2" />
        <Skeleton className="h-4 w-full mb-1" />
        <Skeleton className="h-4 w-2/3" />
      </GlassContainer>
    );
  }

  const [appId, storeId] = app.urn.split(':');
  const logoUrl = `/api/marketplace/apps/${app.urn}/image`;

  return (
    <Link to={`/app-store/${storeId}/${appId}`} className="block h-full group">
      <GlassContainer
        className="h-full p-4 hover:bg-white/10 hover:shadow-lg transition-all active:scale-[0.98] flex flex-col min-h-[180px] sm:min-h-[220px]"
        intensity="low"
      >
        <div className="flex items-start justify-between mb-3 sm:mb-4">
          <img
            src={logoUrl}
            alt={app.name}
            className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl shadow-lg object-cover"
            width={64}
            height={64}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling?.classList.remove('hidden');
            }}
          />
          <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white text-xl sm:text-2xl font-bold shadow-lg hidden">
            {app.name.charAt(0)}
          </div>

          <span className="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-semibold">Free</span>
        </div>

        <h3 className="font-bold text-base sm:text-lg mb-1 truncate text-foreground group-hover:text-primary transition-colors">{app.name}</h3>
        <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-grow">{limitText(app.short_desc, 80)}</p>

        <div className="flex items-center justify-end mt-auto">
          <Button variant="ghost" size="sm" className="h-8 w-8 rounded-full p-0">
            <Download className="w-4 h-4" />
          </Button>
        </div>
      </GlassContainer>
    </Link>
  );
};
