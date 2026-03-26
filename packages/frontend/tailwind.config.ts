import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './node_modules/tauri-controls/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'system-ui', 'sans-serif'],
      },
      transitionProperty: {
        radius: 'border-radius',
      },
      fontSize: {
        xxs: '0.625rem',
        tiny: '0.5rem',
      },
    },
  },
} satisfies Config;
