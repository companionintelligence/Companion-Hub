import { useMemo } from 'react';
import './global-background.css';

interface GlobalBackgroundProps {
  backgroundImage?: string | null;
}

const GRADIENT_COLORS = [
  '#cde1ba',
  '#bbd9b2',
  '#A7cea9',
  '#84bd9a',
  '#61a98f',
  '#409987',
  '#1e7f7f',
  '#1a737c',
  '#106178',
  '#134a73',
];

export const GlobalBackground = ({ backgroundImage }: GlobalBackgroundProps) => {
  const gradientStyle = useMemo(() => {
    if (backgroundImage) return {};

    return {
      backgroundImage: `linear-gradient(90deg, ${GRADIENT_COLORS.join(', ')})`,
    };
  }, [backgroundImage]);

  if (backgroundImage) {
    return <div className="background--image" style={{ backgroundImage: `url(${backgroundImage})` }} />;
  }

  return <div className="background--custom" style={gradientStyle} />;
};
