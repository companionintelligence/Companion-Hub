import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { filterAlternativesBySearch } from '@/lib/store-search';
import { colorSchemeForCategory, iconForCategory } from '@/modules/app/helpers/table-helpers';
import type { AltEntry, AltsCategory } from '@/modules/onboarding/helpers/types';
import clsx from 'clsx';
import { ArrowRight, Search, X } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

type AlternativesCatalogProps = {
  alternatives: AltsCategory;
  marketplaceSlug: string;
  title?: string;
  subtitle?: string;
  query?: string;
  catalogSlugs: ReadonlySet<string>;
  trustAppSlugs: boolean;
};

type Product = {
  name: string;
  icon?: string | null;
  alternativeCount: number;
};

type Alternative = AltEntry['alternatives'][number];
type Proprietary = AltEntry['proprietary'][number];

const POPULAR_COUNT = 8;
const SUGGESTION_COUNT = 8;

function categoryLabel(category: string): string {
  return category === 'ai' || category === 'mcp' ? category.toUpperCase() : category.charAt(0).toUpperCase() + category.slice(1);
}

function collectProducts(data: AltsCategory): Product[] {
  const products = new Map<string, { icon?: string | null; alternatives: Set<string> }>();

  for (const entry of Object.values(data).flat()) {
    for (const proprietary of entry.proprietary) {
      const product = products.get(proprietary.name) ?? { icon: proprietary.icon, alternatives: new Set<string>() };
      product.icon ??= proprietary.icon;

      for (const alternative of entry.alternatives) {
        product.alternatives.add(alternative.name);
      }

      products.set(proprietary.name, product);
    }
  }

  return [...products.entries()]
    .map(([name, product]) => ({ name, icon: product.icon, alternativeCount: product.alternatives.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function BrandIcon({ src, name }: { src?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return <img src={src} alt="" aria-hidden className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" onError={() => setFailed(true)} />;
}

function ProprietaryChips({ items, selected, onToggle }: { items: Proprietary[]; selected: ReadonlySet<string>; onToggle: (name: string) => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const isSelected = selected.has(item.name);

        return (
          <button
            key={item.name}
            type="button"
            aria-pressed={isSelected}
            title={t(isSelected ? 'APP_STORE_ALTERNATIVES_PICKER_STOP_FILTER' : 'APP_STORE_ALTERNATIVES_PICKER_FILTER', { name: item.name })}
            onClick={() => onToggle(item.name)}
            className={clsx(
              'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors',
              isSelected ? 'bg-primary/20 font-semibold text-foreground ring-2 ring-primary' : 'bg-muted/50 hover:bg-muted',
            )}
          >
            <BrandIcon src={item.icon} name={item.name} />
            <span className="font-medium">{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function AlternativeChips({
  items,
  marketplaceSlug,
  catalogSlugs,
  trustAppSlugs,
  highlight,
}: {
  items: Alternative[];
  marketplaceSlug: string;
  catalogSlugs: ReadonlySet<string>;
  trustAppSlugs: boolean;
  highlight: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((alternative) => {
        const key = `${alternative.name}:${alternative.appSlug ?? alternative.url}`;

        const isAvailable = Boolean(alternative.appSlug && (catalogSlugs.has(alternative.appSlug) || trustAppSlugs));

        if (alternative.appSlug && isAvailable) {
          return (
            <Link
              key={key}
              to={`/store/${marketplaceSlug}/${alternative.appSlug}`}
              className={clsx(
                'flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20',
                highlight && 'bg-primary/20 ring-1 ring-primary/60',
              )}
            >
              <BrandIcon src={alternative.icon} name={alternative.name} />
              {alternative.name}
              <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
            </Link>
          );
        }

        return (
          <div key={key} className="flex cursor-not-allowed items-center gap-2 rounded-full bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground">
            <span className="grayscale">
              <BrandIcon src={alternative.icon} name={alternative.name} />
            </span>
            {alternative.name}
            <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-xs">{t('ONBOARDING_SOON')}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProductPicker({
  products,
  selected,
  onToggle,
  onClear,
}: {
  products: Product[];
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const popular = useMemo(
    () =>
      [...products]
        .sort((a, b) => b.alternativeCount - a.alternativeCount || a.name.localeCompare(b.name))
        .filter((product) => !selected.has(product.name))
        .slice(0, POPULAR_COUNT),
    [products, selected],
  );

  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();

    if (!needle) return [];

    return products
      .filter((product) => !selected.has(product.name) && product.name.toLowerCase().includes(needle))
      .sort(
        (a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name),
      )
      .slice(0, SUGGESTION_COUNT);
  }, [products, selected, text]);

  const pick = (name: string) => {
    onToggle(name);
    setText('');
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Backspace' && !text && selected.size > 0) {
      const lastSelected = [...selected].at(-1);
      if (lastSelected) onToggle(lastSelected);
    }
  };

  const showList = open && matches.length > 0;

  return (
    <search aria-label={t('APP_STORE_ALTERNATIVES_SEARCH_LABEL')} className="block rounded-lg border bg-card p-4 shadow-sm sm:p-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const choice = matches[active] ?? matches[0];
          if (choice) pick(choice.name);
        }}
      >
        <div className="mb-3">
          <label htmlFor={`${listId}-input`} className="text-base font-semibold">
            {t('APP_STORE_ALTERNATIVES_PICKER_LABEL')}
          </label>
          <p className="text-sm text-muted-foreground">{t('APP_STORE_ALTERNATIVES_PICKER_HELP')}</p>
        </div>

        <div className="relative">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background/40 px-3 py-2 focus-within:ring-2 focus-within:ring-primary">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            {[...selected].map((name) => (
              <span key={name} className="flex items-center gap-1 rounded-full bg-primary/20 py-0.5 pl-2.5 pr-1 text-sm font-medium">
                {name}
                <button
                  type="button"
                  onClick={() => onToggle(name)}
                  aria-label={t('APP_STORE_ALTERNATIVES_PICKER_REMOVE', { name })}
                  className="rounded-full p-0.5 hover:bg-primary/30"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ))}
            <input
              id={`${listId}-input`}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={showList ? `${listId}-${active}` : undefined}
              autoComplete="off"
              value={text}
              placeholder={t(selected.size > 0 ? 'APP_STORE_ALTERNATIVES_PICKER_ADD_ANOTHER' : 'APP_STORE_ALTERNATIVES_PICKER_PLACEHOLDER')}
              onChange={(event) => {
                setText(event.target.value);
                setActive(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKeyDown}
              className="min-w-[10rem] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
            />
            {selected.size > 0 && (
              <button type="button" onClick={onClear} className="text-sm text-muted-foreground hover:text-foreground">
                {t('APP_STORE_ALTERNATIVES_PICKER_CLEAR')}
              </button>
            )}
          </div>

          {showList && (
            <div id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border bg-popover p-1 shadow-lg">
              {matches.map((product, index) => (
                <div
                  key={product.name}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(product.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      pick(product.name);
                    }
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={clsx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', index === active && 'bg-primary/15')}
                >
                  <BrandIcon src={product.icon} name={product.name} />
                  <span className="font-medium">{product.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {product.alternativeCount}{' '}
                    {t(product.alternativeCount === 1 ? 'APP_STORE_ALTERNATIVES_COUNT_ONE' : 'APP_STORE_ALTERNATIVES_COUNT_OTHER')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {popular.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('APP_STORE_ALTERNATIVES_PICKER_POPULAR')}</span>
            {popular.map((product) => (
              <button
                key={product.name}
                type="button"
                onClick={() => pick(product.name)}
                className="flex items-center gap-1.5 rounded-full bg-muted/50 px-2.5 py-1 text-sm hover:bg-muted"
              >
                <BrandIcon src={product.icon} name={product.name} />
                {product.name}
              </button>
            ))}
          </div>
        )}
      </form>
    </search>
  );
}

export function AlternativesCatalog({
  alternatives,
  marketplaceSlug,
  title,
  subtitle,
  query,
  catalogSlugs,
  trustAppSlugs,
}: AlternativesCatalogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const products = useMemo(() => collectProducts(alternatives), [alternatives]);

  const toggle = (name: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const filtered = useMemo(() => {
    const searched = filterAlternativesBySearch(alternatives, query ?? '');
    const result: AltsCategory = {};

    for (const [category, entries] of Object.entries(searched)) {
      const matches = entries.filter((entry) => selected.size === 0 || entry.proprietary.some((item) => selected.has(item.name)));
      if (matches.length > 0) result[category] = matches;
    }

    return result;
  }, [alternatives, query, selected]);

  const visible = Object.entries(filtered);
  const rowCount = visible.reduce((sum, [, entries]) => sum + entries.length, 0);

  return (
    <div className="min-w-0 space-y-6">
      {(title || subtitle) && (
        <div>
          {title ? <h2 className="mb-1 text-xl font-semibold text-foreground sm:text-2xl">{title}</h2> : null}
          {subtitle ? <p className="text-muted-foreground">{subtitle}</p> : null}
        </div>
      )}

      <ProductPicker products={products} selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} />

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" role="status" aria-live="polite">
          <span>
            {rowCount === 0
              ? t('APP_STORE_ALTERNATIVES_SELECTION_NO_MATCHES')
              : t(rowCount === 1 ? 'APP_STORE_ALTERNATIVES_SELECTION_MATCHES_ONE' : 'APP_STORE_ALTERNATIVES_SELECTION_MATCHES', {
                  count: rowCount,
                  products: [...selected].join(', '),
                })}
          </span>
          <button type="button" onClick={() => setSelected(new Set())} className="font-medium text-primary hover:underline">
            {t('APP_STORE_ALTERNATIVES_SHOW_ALL')}
          </button>
        </div>
      ) : (
        <nav aria-label={t('APP_STORE_ALTERNATIVES_JUMP_TO_CATEGORY')} className="flex flex-wrap gap-2">
          {visible.map(([category, entries]) => (
            <a
              key={category}
              href={`#${category}`}
              onClick={(event) => {
                event.preventDefault();
                scrollToId(category);
              }}
              className="rounded-full bg-muted/50 px-3 py-1 text-sm hover:bg-muted"
            >
              {categoryLabel(category)}
              <span className="ml-1.5 text-xs text-muted-foreground">{entries.length}</span>
            </a>
          ))}
        </nav>
      )}

      {query?.trim() && <p className="text-sm text-muted-foreground">{t('APP_STORE_ALTERNATIVES_SHOWING_QUERY', { query: query.trim() })}</p>}

      {visible.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">{t('APP_STORE_ALTERNATIVES_NO_RESULTS')}</div>
      ) : (
        visible.map(([category, entries]) => {
          const categoryInfo = iconForCategory.find((item) => item.id === category);
          const Icon = categoryInfo?.icon;
          const color = colorSchemeForCategory[category] || 'blue';

          return (
            <Card key={category} id={category} className="scroll-mt-20 overflow-hidden">
              <CardHeader className="border-b bg-muted/30 px-3 py-3 sm:px-6 sm:py-4">
                <CardTitle className="flex items-center gap-2 text-base text-primary">
                  {Icon ? <Icon className={clsx('h-4 w-4', `text-${color}`)} /> : null}
                  {t('APP_STORE_ALTERNATIVES_CATEGORY_TITLE', { category: categoryLabel(category) })}
                </CardTitle>
              </CardHeader>

              <div className="divide-y divide-border md:hidden">
                {entries.map((entry, index) => {
                  const matched = entry.proprietary.some((item) => selected.has(item.name));

                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Static alternatives catalog rows
                    <div key={index} className={clsx('space-y-3 px-3 py-4', matched && 'bg-primary/5')}>
                      <div>
                        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('APP_STORE_PROPRIETARY')}</p>
                        <ProprietaryChips items={entry.proprietary} selected={selected} onToggle={toggle} />
                      </div>
                      <div>
                        <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <ArrowRight className="h-3 w-3" aria-hidden /> {t('APP_STORE_OPEN_SOURCE_ALTERNATIVES')}
                        </p>
                        <AlternativeChips
                          items={entry.alternatives}
                          marketplaceSlug={marketplaceSlug}
                          catalogSlugs={catalogSlugs}
                          trustAppSlugs={trustAppSlugs}
                          highlight={matched}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden w-full overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableHead className="w-[42%] font-semibold">{t('APP_STORE_PROPRIETARY')}</TableHead>
                      <TableHead className="w-8" aria-hidden />
                      <TableHead className="font-semibold">{t('APP_STORE_OPEN_SOURCE_ALTERNATIVES')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry, index) => {
                      const matched = entry.proprietary.some((item) => selected.has(item.name));

                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Static alternatives catalog rows
                        <TableRow key={index} className={clsx(matched && 'bg-primary/5 hover:bg-primary/10')}>
                          <TableCell className="py-3 align-top">
                            <ProprietaryChips items={entry.proprietary} selected={selected} onToggle={toggle} />
                          </TableCell>
                          <TableCell className="w-8 px-0 py-3 text-center align-top text-muted-foreground">
                            <ArrowRight className="mx-auto mt-1.5 h-4 w-4" aria-hidden />
                          </TableCell>
                          <TableCell className="py-3 align-top">
                            <AlternativeChips
                              items={entry.alternatives}
                              marketplaceSlug={marketplaceSlug}
                              catalogSlugs={catalogSlugs}
                              trustAppSlugs={trustAppSlugs}
                              highlight={matched}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
