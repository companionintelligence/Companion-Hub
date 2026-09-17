import { Button } from '@/components/ui/Button';
import { AppStoreSearchInput } from '@/modules/app/components/app-store-search-input/app-store-search-input';
import { getCategoryLabel } from '@/modules/app/helpers/category-label';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { buildStoreIndexPath } from '@/lib/store-browse-params';
import { useAppStoreState } from '@/stores/app-store';
import clsx from 'clsx';
import { ArrowLeftRight, LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

const ALTERNATIVES_VIEW = '__alternatives__' as const;
const STORE_INDEX_PATTERN = /^\/store\/?$/;

export const AppStoreSidebar = () => {
  const { t } = useTranslation();
  const { setCategory, category, setSearch, search, storeId } = useAppStoreState();
  const [localSearch, setLocalSearch] = useState(search);
  const navigate = useNavigate();
  const location = useLocation();

  const isAlternativesView = category === ALTERNATIVES_VIEW;

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  const navigatePreservingBrowseContext = useCallback(() => {
    if (!STORE_INDEX_PATTERN.test(location.pathname)) {
      navigate(buildStoreIndexPath({ q: search.trim() ? search : undefined, category, store: storeId }));
    }
  }, [navigate, location.pathname, search, category, storeId]);

  const onSearch = useCallback(
    (value: string) => {
      setLocalSearch(value);
      // Featured is a curated feed, not an exhaustive searchable catalog.
      // When a user starts searching there, switch to "All" to show full results.
      if (category === 'featured' && value.trim().length > 0) {
        setCategory(undefined);
      }
      setSearch(value);
      navigatePreservingBrowseContext();
    },
    [category, setCategory, setSearch, navigatePreservingBrowseContext],
  );

  const handleCategoryClick = useCallback(
    (cat?: typeof category) => {
      setCategory(cat);
      navigatePreservingBrowseContext();
    },
    [setCategory, navigatePreservingBrowseContext],
  );

  return (
    <aside className="ml-6 mb-6 hidden max-h-[calc(100%-1.5rem)] w-64 flex-shrink-0 self-start flex-col overflow-hidden rounded-lg border border-border/70 bg-card/90 shadow-sm shadow-slate-300/70 md:flex dark:border-white/10 dark:bg-muted/10 dark:shadow-none">
      <div className="p-4 border-b">
        <AppStoreSearchInput value={localSearch} onChange={onSearch} />
      </div>
      <div className="flex-1 overflow-y-auto py-4 px-2 no-scrollbar">
        <div className="space-y-1">
          {/* All Apps */}
          <Button
            variant="ghost"
            className={clsx(
              'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
              category ? 'text-muted-foreground hover:bg-muted/50' : 'bg-primary/10 text-primary font-medium hover:bg-primary/20',
            )}
            onClick={() => handleCategoryClick(undefined)}
          >
            <LayoutGrid className="h-4 w-4" />
            <span className="truncate">{t('COMMON_ALL')}</span>
          </Button>

          <div className="my-2 mx-3 border-t border-border/50" />
          <Button
            variant="ghost"
            className="w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto text-muted-foreground hover:bg-muted/50"
            onClick={() => navigate('/apps/expose')}
          >
            <span className="truncate">{t('PORT_EXPOSE_SIDEBAR_LINK')}</span>
          </Button>

          {/* Alternatives - special item */}
          <div className="my-2 mx-3 border-t border-border/50" />
          <Button
            variant="ghost"
            className={clsx(
              'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
              isAlternativesView ? 'bg-primary/10 text-primary font-medium hover:bg-primary/20' : 'text-muted-foreground hover:bg-muted/50',
            )}
            onClick={() => handleCategoryClick(ALTERNATIVES_VIEW)}
          >
            <ArrowLeftRight className="h-4 w-4" />
            <span className="truncate">{t('APP_STORE_ALTERNATIVES')}</span>
          </Button>
          <div className="my-2 mx-3 border-t border-border/50" />

          {/* Categories */}
          {iconForCategory.map((cat) => {
            const Icon = cat.icon;
            const isSelected = category === cat.id;

            return (
              <Button
                key={cat.id}
                variant="ghost"
                className={clsx(
                  'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
                  isSelected ? 'bg-primary/10 text-primary font-medium hover:bg-primary/20' : 'text-muted-foreground hover:bg-muted/50',
                )}
                onClick={() => handleCategoryClick(cat.id)}
              >
                {Icon && <Icon className="h-4 w-4" />}
                <span className="truncate">{getCategoryLabel(t, cat.id)}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
