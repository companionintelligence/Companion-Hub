import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { colorSchemeForCategory, iconForCategory } from '@/modules/app/helpers/table-helpers';
import type { AltEntry, AltsCategory } from '@/modules/onboarding/helpers/types';
import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

type AlternativesCatalogProps = {
  alternatives: AltsCategory;
  marketplaceSlug: string;
  title?: string;
  subtitle?: string;
};

export function AlternativesCatalog({ alternatives, marketplaceSlug, title, subtitle }: AlternativesCatalogProps) {
  const { t } = useTranslation();

  return (
    <div className="min-w-0 space-y-6">
      {(title || subtitle) && (
        <div>
          {title ? <h2 className="mb-1 text-xl font-semibold text-foreground sm:text-2xl">{title}</h2> : null}
          {subtitle ? <p className="text-muted-foreground">{subtitle}</p> : null}
        </div>
      )}
      {Object.entries(alternatives).map(([altCategory, items]) => {
        const categoryInfo = iconForCategory.find((c) => c.id === altCategory);
        const Icon = categoryInfo?.icon;
        const color = colorSchemeForCategory[altCategory] || 'blue';

        return (
          <Card key={altCategory} className="overflow-hidden">
            <CardHeader className="border-b bg-muted/30 px-3 py-3 sm:px-6 sm:py-4">
              <div className="flex items-center gap-2">
                {Icon && <Icon className={clsx('h-5 w-5', `text-${color}`)} />}
                <CardTitle className="capitalize text-base">{altCategory}</CardTitle>
              </div>
            </CardHeader>
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableHead className="w-1/2 px-2 font-semibold sm:px-4">{t('APP_STORE_PROPRIETARY')}</TableHead>
                    <TableHead className="w-1/2 px-2 font-semibold sm:px-4">{t('APP_STORE_OPEN_SOURCE_ALTERNATIVES')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(items as AltEntry[]).map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Static list
                    <TableRow key={index}>
                      <TableCell className="px-2 py-3 sm:px-4">
                        <div className="flex flex-wrap gap-2">
                          {item.proprietary.map((prop) => (
                            <div
                              key={prop.name}
                              className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm text-foreground"
                              title={prop.name}
                            >
                              {prop.icon && <img src={prop.icon} alt={prop.name} className="h-5 w-5 rounded-full object-cover" loading="lazy" />}
                              <span className="font-medium">{prop.name}</span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-3 sm:px-4">
                        <div className="flex flex-wrap gap-2">
                          {item.alternatives.map((alt) => {
                            if (alt.appSlug) {
                              return (
                                <Link
                                  key={alt.name}
                                  to={`/store/${marketplaceSlug}/${alt.appSlug}`}
                                  className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
                                >
                                  {alt.icon && <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover" loading="lazy" />}
                                  {alt.name}
                                  <ArrowRight className="h-3 w-3 shrink-0" />
                                </Link>
                              );
                            }
                            return (
                              <div
                                key={alt.name}
                                className="flex cursor-not-allowed items-center gap-2 rounded-full bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground"
                              >
                                {alt.icon && (
                                  <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover grayscale" loading="lazy" />
                                )}
                                {alt.name}
                                <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-xs">{t('ONBOARDING_SOON')}</span>
                              </div>
                            );
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
