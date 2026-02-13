import { LanguageSelector } from '@/components/language-selector/language-selector';
import { Card, CardContent } from '@/components/ui/Card';
import { useUserContext } from '@/context/user-context';
import type { Locale } from '@/lib/i18n/locales';
import { getLogo } from '@/lib/theme/theme';
import i18next from 'i18next';
import type { PropsWithChildren } from 'react';

export const AuthLayout = ({ children }: PropsWithChildren) => {
  const locale = i18next.language;

  const { allowAutoThemes } = useUserContext();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="absolute top-3 right-3">
        <LanguageSelector locale={locale as Locale} />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
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
        <Card className="w-full">
          <CardContent className="p-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
};
