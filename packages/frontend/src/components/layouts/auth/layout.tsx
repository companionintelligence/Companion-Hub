import { LanguageSelector } from '@/components/language-selector/language-selector';
import { Card, CardContent } from '@/components/ui/Card';
import { useUserContext } from '@/context/user-context';
import type { Locale } from '@/lib/i18n/locales';
import { getLogo } from '@/lib/theme/theme';
import i18next from 'i18next';
import type { PropsWithChildren } from 'react';
import { cn } from '@/lib/utils';

type AuthLayoutProps = PropsWithChildren<{
  wide?: boolean;
}>;

export const AuthLayout = ({ children, wide = false }: AuthLayoutProps) => {
  const locale = i18next.language;

  const { allowAutoThemes } = useUserContext();
  return (
    <div
      className="flex flex-col items-center overflow-y-auto bg-background px-4 pb-8"
      style={{ height: 'calc(100vh - var(--titlebar-height, 0px))', paddingTop: 'calc(var(--titlebar-height, 0px) + 2rem)' }}
    >
      <div className="absolute right-3" style={{ top: 'calc(var(--titlebar-height, 0px) + 0.25rem)' }}>
        <LanguageSelector locale={locale as Locale} />
      </div>
      <div className={cn('w-full my-auto', wide ? 'max-w-4xl' : 'max-w-md')}>
        <div className="mb-6 text-center">
          <img
            alt="Companion Hub logo"
            src={getLogo(allowAutoThemes)}
            height={80}
            width={80}
            className="mx-auto"
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
        </div>
        <Card className={cn('w-full', wide && 'border-primary/30 shadow-[0_0_48px_-12px] shadow-primary/25 ring-1 ring-primary/20')}>
          <CardContent className={cn('p-6', wide && 'md:p-8')}>{children}</CardContent>
        </Card>
      </div>
    </div>
  );
};
