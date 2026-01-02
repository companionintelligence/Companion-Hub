import { BaseHeader } from './base-header';

type HeaderProps = {
  isUpdateAvailable: boolean;
  isLoggedIn: boolean;
  allowAutoThemes: boolean;
};

export const Header = (props: HeaderProps) => {
  const { allowAutoThemes, isLoggedIn } = props;

  return <BaseHeader isLoggedIn={isLoggedIn} allowAutoThemes={allowAutoThemes} showNav={false} navbarContent={null} />;
};
