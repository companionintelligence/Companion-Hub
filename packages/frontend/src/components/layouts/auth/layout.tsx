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
    <div className="page page-center">
      <div className="position-absolute top-0 mt-3 end-0 me-1 pb-4">
        <LanguageSelector locale={locale as Locale} />
      </div>
      <div className="container container-tight py-4">
        <div className="text-center mb-4">
          <img
            alt="Companion Hub logo"
            src={getLogo(allowAutoThemes)}
            height={128}
            width={128}
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
        </div>
        <Card className="max-w-md w-full mx-auto">
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </div>
  );
};
