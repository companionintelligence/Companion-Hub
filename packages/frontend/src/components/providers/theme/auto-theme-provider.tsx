import { useUserContext } from '@/context/user-context';
import { getAutoTheme } from '@/lib/theme/theme';
import { type PropsWithChildren, Suspense, lazy } from 'react';

const ChristmasTheme = lazy(() => import('./themes/christmas').then((module) => ({ default: module.ChristmasTheme })));

type Props = {
  initialTheme?: string;
};

export const AutoThemeProvider = (props: PropsWithChildren<Props>) => {
  const { children } = props;
  const { allowAutoThemes } = useUserContext();

  // The theme renders beside the page, not around it, so switching it on or off doesn't remount the page.
  return (
    <>
      {allowAutoThemes && getAutoTheme() === 'christmas' && (
        <Suspense>
          <ChristmasTheme />
        </Suspense>
      )}
      {children}
    </>
  );
};
