import { cn } from '@/lib/utils';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type AppStoreSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function AppStoreSearchInput({ value, onChange, className }: AppStoreSearchInputProps) {
  const { t } = useTranslation();
  const showClear = value.length > 0;

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
      <input
        type="search"
        placeholder={t('APP_STORE_SEARCH_APPS')}
        className="flex h-9 w-full rounded-md border border-input bg-muted/50 py-1 pl-9 pr-9 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {showClear ? (
        <button
          type="button"
          aria-label={t('CLEAR')}
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onChange('')}
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
