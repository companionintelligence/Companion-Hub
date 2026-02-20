import clsx from 'clsx';
import { Check } from 'lucide-react';
import type React from 'react';

export const THEME_COLOR_ENUM = {
  blue: 'blue',
  azure: 'azure',
  indigo: 'indigo',
  purple: 'purple',
  pink: 'pink',
  red: 'red',
  orange: 'orange',
  yellow: 'yellow',
  lime: 'lime',
  green: 'green',
  teal: 'teal',
  cyan: 'cyan',
} as const;
export type ThemeColor = (typeof THEME_COLOR_ENUM)[keyof typeof THEME_COLOR_ENUM];

const COLOR_MAP: Record<ThemeColor, string> = {
  blue: 'bg-blue-500',
  azure: 'bg-sky-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-500',
  lime: 'bg-lime-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
};

interface ColorSelectorProps {
  name?: string;
  label?: string;
  className?: string;
  value?: ThemeColor;
  onChange?: (value: ThemeColor) => void;
}

export const ColorSelector: React.FC<ColorSelectorProps> = ({ name = 'color', label = 'Primary color', className, value, onChange }) => {
  const handleChange = (color: ThemeColor) => {
    document.body.dataset.bsThemePrimary = color;
    onChange?.(color);
  };

  return (
    <div className={clsx(className)} id={`${name}-group`}>
      <label className="block text-sm font-medium text-foreground mb-2" htmlFor={`${name}-group`}>
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        {Object.values(THEME_COLOR_ENUM).map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={color}
            onClick={() => handleChange(color)}
            className={clsx(
              'relative h-8 w-8 rounded-full transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              COLOR_MAP[color],
              value === color ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground scale-110' : 'hover:scale-110',
            )}
          >
            {value === color && <Check className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow-sm" strokeWidth={3} />}
            <input type="radio" name={name} value={color} checked={value === color} onChange={() => handleChange(color)} className="sr-only" />
          </button>
        ))}
      </div>
    </div>
  );
};
