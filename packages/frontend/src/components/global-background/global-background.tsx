import { useMemo } from 'react';
import './global-background.css';

interface GlobalBackgroundProps {
  backgroundImage?: string | null;
}

const generateRandomColor = () => {
  // Use HSL to ensure vibrant colors (high saturation, medium lightness)
  // Hue: 0-360
  // Saturation: 70-100% (avoids gray)
  // Lightness: 40-60% (avoids white and black)
  const hue = Math.floor(Math.random() * 360);
  const saturation = Math.floor(Math.random() * 30) + 70;
  const lightness = Math.floor(Math.random() * 20) + 40;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

export const GlobalBackground = ({ backgroundImage }: GlobalBackgroundProps) => {
  const gradientStyle = useMemo(() => {
    if (backgroundImage) return {};

    const color1 = generateRandomColor();
    const color2 = generateRandomColor();
    const color3 = generateRandomColor();

    return {
      backgroundImage: `linear-gradient(90deg, ${color1}, ${color2}, ${color3})`,
    };
  }, [backgroundImage]);

  if (backgroundImage) {
    return <div className="background--image" style={{ backgroundImage: `url(${backgroundImage})` }} />;
  }

  return <div className="background--custom" style={gradientStyle} />;
};
